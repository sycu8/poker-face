const BMC_URL = "https://buymeacoffee.com/Sycule";

/** Official Buy Me a Coffee button linking to @Sycule. */
export function BuyMeACoffeeLink({ className }: { className?: string }) {
  return (
    <a
      href={BMC_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={["bmc-link", className].filter(Boolean).join(" ")}
      aria-label="Buy me a coffee on Buy Me a Coffee"
    >
      <img
        src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
        alt="Buy Me a Coffee"
        width={162}
        height={44}
        loading="lazy"
        decoding="async"
      />
    </a>
  );
}
