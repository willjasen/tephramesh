export class MeshNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshNotReadyError";
  }
}
