/** Public links in one place. The GitHub org/repo here must match plugins.updater in tauri.conf.json. */
export const BRAND = {
  name: "Forge",
  company: "Stellitron",
  site: "https://forge.stellitron.com",
  companySite: "https://stellitron.com",
  repo: "https://github.com/stellitron/forge",
  license: "Apache-2.0",
};

export const links = {
  releases: `${BRAND.repo}/releases`,
  issues: `${BRAND.repo}/issues/new/choose`,
  security: `${BRAND.repo}/security/policy`,
  docs: `${BRAND.repo}#readme`,
  license: `${BRAND.repo}/blob/main/LICENSE`,
};
