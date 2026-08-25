import { avatarColor, initials } from "./avatar";

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
