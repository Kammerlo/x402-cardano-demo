declare module "serialize-error/index.js" {
  export * from "serialize-error";

  const serializeErrorModule: typeof import("serialize-error");
  export default serializeErrorModule;
}
