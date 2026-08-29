/** Render a small deterministic identicon from Syncthing's public-key-derived device ID. */
export function renderDeviceAvatar(container: HTMLElement, deviceId: string): void {
  const seed = deviceId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "DEVICE";
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  const hue = Math.abs(hash) % 360;
  const pattern = Array.from({ length: 15 }, (_, index) => {
    hash = Math.imul(hash ^ (index + 1), 16777619);
    return (hash >>> 0) % 2 === 0;
  });
  const cells = pattern.flatMap((filled, index) => {
    if (!filled) return [];
    const row = Math.floor(index / 3);
    const column = index % 3;
    return [1 + column, 5 - column].map((x) =>
      `<rect x="${x}" y="${row + 1}" width="1" height="1"/>`,
    );
  }).join("");

  container.empty();
  container.innerHTML = `<svg viewBox="0 0 7 7" aria-hidden="true" focusable="false" style="--tephramesh-avatar-hue:${hue}"><rect class="tephramesh-device-avatar-bg" x="0" y="0" width="7" height="7" rx="1.5"/><g class="tephramesh-device-avatar-fg">${cells}</g></svg>`;
  container.setAttribute("role", "img");
  container.setAttribute("aria-label", "Device profile picture derived from its public key");
  container.setAttribute("title", "Profile picture derived from the device public key");
}
