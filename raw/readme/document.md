# Source documents

The original documents every published page traces back to. They are kept in the repository as the first link in the provenance chain — `sources/` → `raw/` (parsed Markdown) → `enriched/` (per-stage agent output) → `docs/` (the published page).

They are kept **only** because their licences permit redistribution. Before adding a document here, check what its licence allows: if it can't be redistributed, leave it out of the repo and let the pipeline work from a local copy — the parsed text in `raw/` is subject to the same terms.

| File | Work | Authors | Venue | Licence |
| --- | --- | --- | --- | --- |
| `p-gingivalis-ad-review.pdf` | [Porphyromonas gingivalis and Alzheimer disease: Recent findings and potential therapies](https://doi.org/10.1002/JPER.20-0104) | Ryder M.I. | *Journal of Periodontology*, 2020 | CC BY — open access under the terms of the Creative Commons Attribution License. ©2020 The Authors, published by Wiley Periodicals LLC on behalf of American Academy of Periodontology |
| `buntanetap-phase-2-3-ad.pdf` | [Buntanetap treatment in mild to moderate Alzheimer's disease: phase 2/3 study](https://doi.org/10.1038/s44400-026-00073-z) | Fang C. et al. | *npj Dementia*, 2026 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). © The Author(s) 2026 |

Full per-author credits, affiliations, and declared conflicts are extracted into `enriched/<id>/01-analysis.json` and published on each paper page's **Attribution** section and in the [author index](../docs/research/authors.mdx). See [ATTRIBUTION.md](../ATTRIBUTION.md).
