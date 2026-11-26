// Types `exports.default` from cloudflare:workers as this Worker's default export.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
