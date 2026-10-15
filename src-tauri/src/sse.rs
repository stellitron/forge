//! Minimal incremental Server-Sent Events parser.

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
    pub id: Option<String>,
}

#[derive(Default)]
pub struct SseParser {
    buf: String,
}

impl SseParser {
    /// Feed raw bytes; returns every event completed by this chunk.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.push_str(&String::from_utf8_lossy(chunk));
        if self.buf.contains('\r') {
            self.buf = self.buf.replace("\r\n", "\n").replace('\r', "\n");
        }
        let mut out = Vec::new();
        while let Some(pos) = self.buf.find("\n\n") {
            let block: String = self.buf.drain(..pos + 2).collect();
            if let Some(ev) = parse_block(&block) {
                out.push(ev);
            }
        }
        out
    }
}

fn parse_block(block: &str) -> Option<SseEvent> {
    let mut ev = SseEvent::default();
    let mut data_lines: Vec<&str> = Vec::new();
    for line in block.lines() {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => ev.event = Some(value.to_string()),
            "data" => data_lines.push(value),
            "id" => ev.id = Some(value.to_string()),
            _ => {}
        }
    }
    if data_lines.is_empty() && ev.event.is_none() {
        return None;
    }
    ev.data = data_lines.join("\n");
    Some(ev)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_split_chunks() {
        let mut p = SseParser::default();
        assert!(p.feed(b"event: endpoint\nda").is_empty());
        let evs = p.feed(b"ta: /messages?x=1\r\n\r\ndata: {\"a\":1}\ndata: 2\n\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].event.as_deref(), Some("endpoint"));
        assert_eq!(evs[0].data, "/messages?x=1");
        assert_eq!(evs[1].data, "{\"a\":1}\n2");
    }
}
