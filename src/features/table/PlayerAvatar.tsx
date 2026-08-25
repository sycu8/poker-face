/* eslint-disable react-refresh/only-export-components */
/** Stable avatar color from a display name. */
export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 42% 38%)`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

export function PlayerAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      className="player-avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: avatarColor(name),
        fontSize: size * 0.38,
      }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}
