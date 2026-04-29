declare module "bech32/dist/index.js" {
  export * from "bech32";

  const bech32Module: typeof import("bech32");
  export default bech32Module;
}
