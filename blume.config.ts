import { defineConfig } from "blume";

export default defineConfig({
  title: "Alzheimer's Research",
  description:
    "A working knowledge base for Alzheimer's disease research: consolidated paper notes, a clinical trial tracker, and a timeline of the field.",
  navigation: {
    tabs: [
      { label: "Research", path: "/research", icon: "book-open" },
      { label: "Trials", path: "/trials", icon: "flask-conical" },
      { label: "Timeline", path: "/timeline", icon: "calendar" },
    ],
  },
  search: {
    // Orama is the default provider: keyless, client-side, works in dev and build.
    popular: [
      { href: "/timeline", icon: "calendar", label: "Timeline" },
      { href: "/trials", icon: "flask-conical", label: "Trial tracker" },
      { href: "/research", icon: "book-open", label: "Research notes" },
      {
        href: "/research/templates/paper-note",
        icon: "file-plus",
        label: "Add a paper note",
      },
    ],
  },
});
