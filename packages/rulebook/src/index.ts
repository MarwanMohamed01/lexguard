import gdprFile from "../data/gdpr.json";
import ndaFile from "../data/nda.json";
import { parseRulebook, type Rulebook } from "./rulebook";

export { parseOjRegulation, type ParsedRegulation, type ParsedRule } from "./parse-oj";
export { searchRules, terms, type SearchHit } from "./search";
export {
  getRule,
  parseRulebook,
  ruleText,
  rulesOfArticle,
  type Rule,
  type Rulebook,
  type RuleSource,
} from "./rulebook";

/** GDPR, Regulation (EU) 2016/679, Official Journal text (D45). */
export const gdpr: Rulebook = parseRulebook(gdprFile);
/** ContractNLI's 17 hypotheses as an NDA playbook (D45). */
export const ndaPlaybook: Rulebook = parseRulebook(ndaFile);
