"use client";

// The skip link has to move focus, not just scroll. A plain anchor to a
// fragment moves the viewport, but a keyboard or screen reader user who
// activates it stays where they were, so the jump buys nothing. Focus the
// target and make it focusable first: a main region that cannot take focus
// is exactly the region the link is meant to hand over to.
export default function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(event) => {
        event.preventDefault();
        const target = document.getElementById("main-content");
        if (!(target instanceof HTMLElement)) return;
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus();
        target.scrollIntoView({ block: "start" });
      }}
    >
      본문으로 건너뛰기
    </a>
  );
}
