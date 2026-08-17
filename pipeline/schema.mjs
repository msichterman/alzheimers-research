// The evidence record: one shape, used by the builder that extracts it, the
// critic that independently re-extracts it, and the gates that validate it.
//
// The load-bearing decision here is that every extracted value is wrapped:
//
//   { value, quote, location }
//
// `quote` is verbatim text from the retrieved document. That turns two of the
// fidelity rules into mechanical checks rather than judgement calls:
//
//   - "any value in the record that cannot be located in retrieved text is a
//     loss" becomes a substring search against raw/<id>/document.md;
//   - "the field goes null rather than being inferred" becomes: no quote, no
//     value.
//
// It also makes the builder/critic diff meaningful. Two extractions that agree
// on a number but cite different passages have found different things, and that
// is worth surfacing.
import { S } from "./gemini.mjs";

/** A single extracted value with the text it came from. */
const value = (what) =>
  S.obj(
    {
      value: S.str(`${what}. Null if the retrieved document does not state it.`),
      quote: S.str("verbatim text from the retrieved document containing this value; null if value is null"),
      location: S.str("where in the document, e.g. 'Results, paragraph 2', 'Table 2', 'Figure 3 caption'"),
    },
    ["value", "quote", "location"],
  );

const numeric = (what) =>
  S.obj(
    {
      value: S.num(`${what}, as a number. Null if not stated.`),
      quote: S.str("verbatim text containing this number; null if value is null"),
      location: S.str("where in the document"),
    },
    ["value", "quote", "location"],
  );

const outcome = S.obj(
  {
    name: S.str("the outcome measure exactly as the document names it, e.g. 'CDR-SB change from baseline at 18 months'"),
    tier: S.str("one of: primary, secondary, exploratory, post_hoc, subgroup. Use the document's own designation."),
    prespecified: S.str("yes, no, or unclear — was this prespecified in the protocol or SAP as described by the document?"),
    prespecification_evidence: S.str("verbatim text supporting the prespecification call, or null if the document does not say"),
    met: S.str("met, not_met, or not_applicable — did it meet its threshold? For a subgroup or post-hoc analysis this is not_applicable."),
    effect_estimate: S.str("the effect estimate with its units exactly as reported, e.g. '-0.45 CDR-SB points'"),
    confidence_interval: S.str("the interval exactly as reported, e.g. '95% CI, -0.67 to -0.23'"),
    p_value: S.str("the p-value exactly as reported, e.g. 'P<0.001'"),
    multiplicity_controlled: S.str("yes, no, or unclear — was this comparison inside the document's multiplicity-control scheme?"),
    quote: S.str("verbatim text reporting this outcome"),
    location: S.str("where in the document"),
  },
  ["name", "tier", "prespecified", "met", "quote", "location"],
);

const harm = S.obj(
  {
    name: S.str("harm exactly as named, e.g. 'ARIA-E', 'ARIA-H', 'symptomatic ARIA', 'macrohemorrhage', 'death'"),
    arm: S.str("which arm, e.g. 'lecanemab 10 mg/kg biweekly', 'placebo'"),
    count: S.str("number affected, exactly as reported"),
    denominator: S.str("number at risk in that arm, exactly as reported"),
    percentage: S.str("percentage exactly as reported"),
    apoe_stratum: S.str("APOE stratum if the document reports this harm by genotype, e.g. 'APOE e4 homozygotes'; null if not stratified"),
    quote: S.str("verbatim text reporting this harm"),
    location: S.str("where in the document"),
  },
  ["name", "arm", "quote", "location"],
);

/** The Gemini responseSchema. The builder prompt describes the same shape. */
export const EVIDENCE_SCHEMA = S.obj(
  {
    document_kind: S.str("what was actually retrieved: journal_article, registry_record, regulatory_review, regulatory_label, regulatory_recall, systematic_review, consensus_statement, preprint, or other"),
    title: value("the document's exact title"),
    authors: S.arr(
      S.obj(
        {
          name: S.str("author name as printed"),
          affiliation: S.str("affiliation as printed, or null"),
          orcid: S.str("ORCID as printed, or null"),
          corresponding: S.bool("is this the corresponding author, as the document states"),
        },
        ["name"],
      ),
      "authors as printed in the retrieved document, in order. Empty array if it has none (a registry record, for example).",
    ),
    study: S.obj(
      {
        design: value("study design in the document's own terms, e.g. 'randomized, double-blind, placebo-controlled, phase 3'"),
        phase: value("trial phase"),
        n: numeric("number of participants randomized or analysed, whichever the document reports as its headline N"),
        n_description: value("what that N counts, e.g. 'randomized', 'enrolled', 'included in the modified intention-to-treat population'"),
        population: value("the population studied, including diagnostic and biomarker entry criteria"),
        followup: value("treatment or follow-up duration"),
        intervention: value("intervention and dose"),
        comparator: value("comparator arm"),
        biomarker_confirmation: value("how disease was biologically confirmed for entry, e.g. 'amyloid PET or CSF'"),
        nct_ids: S.arr(S.str("NCT identifier as printed in the document"), "trial registrations named in the retrieved document"),
        cohorts: S.arr(
          S.str("named research cohort or dataset used, e.g. ADNI, ROSMAP, BioFINDER, DIAN, NACC, ADSP, UK Biobank"),
          "named cohorts or datasets this analysis draws on. This is how correlated publications are detected, so list every one the document names.",
        ),
      },
      ["design", "n", "population"],
    ),
    outcomes: S.arr(outcome, "every outcome the document reports, primary first. Prespecified and post-hoc results are separated by the `tier` and `prespecified` fields and must never be described in the same terms."),
    primary_endpoint_status: S.obj(
      {
        status: S.str("met, not_met, mixed, or not_applicable — the status of the document's own primary endpoint, stated plainly even when the document's framing is more favourable"),
        explanation: S.str("one sentence, grounded in the document's own reported result"),
        quote: S.str("verbatim text that establishes this"),
      },
      ["status", "quote"],
    ),
    multiplicity: S.obj(
      {
        approach: S.str("how the document says it controlled for multiple comparisons, e.g. 'hierarchical gatekeeping', 'Hochberg', 'none stated'"),
        quote: S.str("verbatim text describing it, or null if the document does not address multiplicity"),
        location: S.str("where in the document"),
      },
      ["approach"],
    ),
    safety: S.obj(
      {
        harms: S.arr(harm, "harms with counts by arm. ARIA-E, ARIA-H, symptomatic ARIA, macrohemorrhage and deaths must appear here whenever the document reports them."),
        apoe_stratification_reported: S.bool("does the document report safety stratified by APOE genotype"),
        serious_adverse_events: value("serious adverse events, as reported"),
        deaths: value("deaths, as reported"),
        discontinuations: value("treatment discontinuations, as reported"),
      },
      ["harms", "apoe_stratification_reported"],
    ),
    funding: S.arr(S.str("funding source exactly as declared"), "funding as declared in the document"),
    conflicts: S.arr(S.str("declared conflict of interest, summarised but not softened"), "conflicts as declared in the document"),
    limitations: S.arr(S.str("limitation the document itself states"), "limitations the document states about itself"),
    risk_of_bias: S.arr(
      S.obj({ domain: S.str("bias domain, e.g. 'attrition', 'unblinding via ARIA', 'sponsor analysis'"), judgement: S.str("what the retrieved text supports"), quote: S.str("verbatim support") }, ["domain", "judgement"]),
      "bias concerns supported by the retrieved text, not general priors about the field",
    ),
    disagreements: S.arr(
      S.obj(
        {
          question: S.str("the point at issue"),
          position: S.str("what THIS document concludes"),
          attributed_to: S.str("who holds this position, e.g. 'Cochrane review authors', 'FDA statistical reviewer'"),
          quote: S.str("verbatim support"),
        },
        ["question", "position", "attributed_to"],
      ),
      "positions this document takes that a reader should see attributed rather than merged into a single verdict",
    ),
    linked_objects: S.arr(
      S.obj(
        {
          relation: S.str("one of: correction, retraction, expression_of_concern, recall, post_market_action, registry_record, regulatory_review, secondary_analysis, preprint_of, published_version_of"),
          identifier: S.str("DOI, NCT id, or regulatory identifier of the linked object"),
          note: S.str("what the link is"),
        },
        ["relation", "identifier"],
      ),
      "objects that modify or accompany this record. These are links, never replacements.",
    ),
    trial_status_observation: S.obj(
      {
        status: S.str("recruitment or programme status, ONLY if this document is a registry record or explicitly dates the status"),
        enrollment: S.str("enrollment as stated"),
        phase: S.str("phase as stated"),
        observed_at: S.str("the timestamp or date this observation is valid as of, taken from the document or its retrieval stamp"),
        source: S.str("what stated it, e.g. 'ClinicalTrials.gov API v2'"),
      },
      ["status", "observed_at", "source"],
    ),
    unlocatable_fields: S.arr(
      S.str("the name of a field you were asked for and left null because the retrieved document does not state it"),
      "every field left null because the document does not contain it. Being explicit here is required: it is what separates 'absent from the source' from 'missed by the extractor'.",
    ),
  },
  ["document_kind", "title", "study", "outcomes", "primary_endpoint_status", "safety", "unlocatable_fields"],
);

/** Human-readable shape for the builder prompt, kept in sync with the schema above. */
export const EVIDENCE_SHAPE_NOTE = `Every extracted value is an object { value, quote, location }:
  - value:    what the document states, or null
  - quote:    verbatim text from the retrieved document containing that value
  - location: where in the document it appears

If you cannot find a value in the retrieved text, set value to null and list the
field name in unlocatable_fields. Never infer, never carry a number over from
what you already know about this trial, and never fill a field from the work
order. A null is a correct answer; a remembered number is a failure.`;

/**
 * Fields the critic diffs against the builder, in the order the fidelity bar
 * lists them. A disagreement on any of these is a loss for the record.
 */
export const DIFF_FIELDS = [
  "study.design",
  "study.n",
  "study.population",
  "study.comparator",
  "primary_endpoint_status.status",
  "outcomes[primary].name",
  "outcomes[primary].met",
  "outcomes[primary].effect_estimate",
  "outcomes[primary].confidence_interval",
  "outcomes[*].prespecified",
  "multiplicity.approach",
  "safety.harms[ARIA-E]",
  "safety.harms[ARIA-H]",
  "safety.harms[symptomatic ARIA]",
  "safety.harms[macrohemorrhage]",
  "safety.harms[death]",
  "safety.apoe_stratification_reported",
];
