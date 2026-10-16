/** Scripts the Website radar agent runs inside the page, over DevTools Runtime.evaluate. */

/**
 * Page helpers shared by the scripts below. Many apps (Reddit, YouTube, Salesforce…) build their UI
 * from web components, so elements are found by walking open shadow roots, not just the document.
 */
const DEEP = `
const forgeAll = (root, out = []) => {
  for (const el of root.querySelectorAll('*')) {
    out.push(el);
    if (el.shadowRoot) forgeAll(el.shadowRoot, out);
  }
  return out;
};
const forgeFind = (id) => forgeAll(document).find((e) => e.getAttribute('data-forge-id') === String(id));
const forgeLabel = (el) => {
  const t = (s) => (s || '').trim().replace(/\\s+/g, ' ');
  return t(el.getAttribute('aria-label')) || t(el.labels && el.labels[0] && el.labels[0].innerText) || t(el.innerText) ||
    t(el.shadowRoot && el.shadowRoot.textContent) || t(el.placeholder) || t(el.title) || t(el.getAttribute('name')) || t(el.id);
};
`;

/** Lists the visible controls of the page, numbering each with data-forge-id. */
export const SNAPSHOT = `(() => {${DEEP}
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=radio],[role=combobox],[role=treeitem],[aria-checked],[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const all = forgeAll(document);
  all.forEach((e) => e.removeAttribute('data-forge-id'));
  const out = [];
  let n = 0;
  for (const el of all) {
    if (!el.matches(sel)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < -innerHeight || r.top > innerHeight * 3) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    el.setAttribute('data-forge-id', String(++n));
    const label = forgeLabel(el).slice(0, 80);
    const tag = el.tagName.toLowerCase() + (el.type && el.tagName !== 'BUTTON' ? '[' + el.type + ']' : '') + (el.getAttribute('role') ? '(' + el.getAttribute('role') + ')' : '');
    const href = el.getAttribute('href');
    let state = '';
    if (el.type === 'checkbox' || el.type === 'radio') state = el.checked ? ' [on]' : ' [off]';
    else if (el.getAttribute('aria-checked')) state = el.getAttribute('aria-checked') === 'true' ? ' [on]' : ' [off]';
    else if (el.type !== 'password' && 'value' in el && typeof el.value === 'string' && el.value && /^(input|select|textarea)$/i.test(el.tagName)) state = ' = ' + JSON.stringify(el.value.slice(0, 60));
    out.push('[' + n + '] ' + tag + ' ' + JSON.stringify(label) + state + (href && !href.startsWith('javascript:') ? ' -> ' + href.slice(0, 100) : ''));
    if (n >= 250) break;
  }
  const headings = all.filter((h) => /^H[1-3]$/.test(h.tagName)).slice(0, 12).map((h) => h.innerText.trim().slice(0, 60)).filter(Boolean);
  const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  return JSON.stringify({ title: document.title, url: location.href, headings, scroll: Math.round(scrollY) + '/' + max, elements: out });
})()`;

/** Visible text of the page, shadow roots included. */
export const TEXT = `(() => {
  const out = [];
  const walk = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 1) {
        if (n.shadowRoot) walk(n.shadowRoot);
        continue;
      }
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) || (p.checkVisibility && !p.checkVisibility())) continue;
      const t = n.textContent.trim().replace(/\\s+/g, ' ');
      if (t) out.push(t);
    }
  };
  walk(document.body);
  return out.join('\\n').slice(0, 8000);
})()`;

export const locate = (id: number) => `(() => {${DEEP}
  const el = forgeFind(${id});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const a = el.closest('a');
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, label: forgeLabel(el).slice(0, 80), href: a ? a.href : '', password: el.type === 'password', tag: el.tagName.toLowerCase() });
})()`;

export const focus = (id: number) => `(() => {${DEEP}
  const el = forgeFind(${id});
  el.focus();
  if ('select' in el) el.select();
})()`;
