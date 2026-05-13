// Minimal ambient declaration for guacamole-lite. The package ships no types.
// We use it via a single constructor and a couple of events; this stub is
// intentionally permissive so we don't have to model the whole library.
declare module "guacamole-lite" {
  export default class GuacamoleLite {
    constructor(
      websocketOptions: { server: import("http").Server; path?: string },
      guacdOptions: { host: string; port: number },
      clientOptions?: Record<string, unknown>
    );
    // Intentionally loose: the library emits a handful of events we forward
    // to logs. `any` here keeps consumer signatures untyped, which is fine
    // because we never depend on the exact shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, handler: (...args: any[]) => void): this;
  }
}
