declare module "libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js" {
  const sodium: Record<string, unknown> & {
    ready: Promise<void>;
  };

  export default sodium;
}
