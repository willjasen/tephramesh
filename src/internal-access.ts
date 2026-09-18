/** Capability available only to Tephramesh's bundled UI and core modules. */
export const INTERNAL_SECRET_ACCESS = Symbol("tephramesh-internal-secret-access");

export function requireInternalSecretAccess(access: symbol): void {
  if (access !== INTERNAL_SECRET_ACCESS) {
    throw new Error("Protected Tephramesh data is unavailable through automation APIs.");
  }
}
