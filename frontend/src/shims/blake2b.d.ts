declare module "blake2b/index.js" {
  type Blake2bInstance = {
    update(data: Uint8Array | string): Blake2bInstance;
    digest(encoding?: "hex"): string;
    digest(): Uint8Array;
  };

  const blake2b: {
    (outlen?: number, key?: Uint8Array, salt?: Uint8Array, personal?: Uint8Array): Blake2bInstance;
    ready(callback: () => void): void;
    WASM_SUPPORTED: boolean;
    WASM_LOADED: boolean;
    BYTES_MIN: number;
    BYTES_MAX: number;
    BYTES: number;
    KEYBYTES_MIN: number;
    KEYBYTES_MAX: number;
    KEYBYTES: number;
    SALTBYTES: number;
    PERSONALBYTES: number;
  };

  export default blake2b;
}
