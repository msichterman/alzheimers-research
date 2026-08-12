import { defineComponents } from "blume";
import Footer from "./components/Footer.astro";
import OpenInChat from "./components/OpenInChat.astro";

/**
 * `<OpenInChat />` is available in every MDX page with no import — an inline
 * "open this prompt in your assistant" row, the way AI Elements' <OpenIn />
 * works, but rendered statically by Astro. Its agent-facing Markdown form is
 * registered in `blume.config.ts` under `ai.markdownComponents`.
 */
export default defineComponents({
  mdx: { OpenInChat },
  // Blume ships no footer; this one carries the site-wide attribution and
  // licensing notice that the sources' CC BY terms require.
  layout: { Footer },
});
