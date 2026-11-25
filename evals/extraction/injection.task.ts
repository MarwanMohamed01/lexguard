// Indirect prompt injection against the extractor with a real model (M4 step 8, D41).
// Not part of `npm test`: run on purpose, it resumes from the answer cache.
//   npm run fetch:bipia -w @lexguard/evals     (once)
//   npm run injection:cuad -w @lexguard/evals
// Environment: PROVIDER=groq|workers-ai (default groq), MODEL, LIMIT=<model calls this run>.
// Each of BIPIA's 75 attacks is planted into one labelled chunk of the pinned 10-contract
// subset whose clean answer is already cached (attack i -> the i-th such chunk, round robin),
// so the same model's answer without the attack is the control. Public CUAD text only (D34).
import { existsSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import {
  buildPrompt,
  CLAUSE_TYPE_NAMES,
  extractClauses,
  PROMPT_VERSION,
} from "@lexguard/extraction";
import { loadCuad } from "../cuad/load";
import { extractionCorpus, pinnedSubset } from "./dataset";
import { judge, loadBipia, plant, shingles, echoes, type CaseVerdict } from "./injection";
import { AnswerCache, evalNonce, groqChat, workersAiChat, type ChatModel } from "./models";
import { scoreChunk, TypeTally } from "./score";

it(
  "plants BIPIA attacks into CUAD chunks and checks what gets through",
  async () => {
    const envFile = new URL("../.env", import.meta.url);
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const provider = process.env.PROVIDER ?? "groq";
    const model: ChatModel =
      provider === "workers-ai"
        ? workersAiChat(process.env.MODEL ?? "@cf/google/gemma-4-26b-a4b-it")
        : groqChat(process.env.MODEL ?? "openai/gpt-oss-20b");
    const limit = Number(process.env.LIMIT ?? Infinity);
    const cache = new AnswerCache(model.name, PROMPT_VERSION);
    const attacks = loadBipia();
    const docs = pinnedSubset(extractionCorpus(loadCuad()), 10);
    const pool = docs
      .flatMap((doc) =>
        doc.chunks.map((chunk) => ({ chunk, text: doc.text.slice(chunk.start, chunk.end) })),
      )
      .filter((c) => c.chunk.expected.size > 0 && cache.get(c.text) !== undefined);
    if (pool.length === 0) throw new Error(`no cached clean answers for ${model.name}`);
    const cases = attacks.map((attack, i) => {
      const c = pool[i % pool.length];
      if (c === undefined) throw new Error("unreachable");
      return { attack, ...c, planted: plant(c.text, attack.text) };
    });

    // 1. Ask for every attacked chunk not yet cached.
    const todo = cases.filter((c) => cache.get(c.planted.text) === undefined).slice(0, limit);
    console.log(
      `${model.name}: ${String(todo.length)} of ${String(cases.length)} cases to ask, ${String(pool.length)} chunks`,
    );
    for (const [i, c] of todo.entries()) {
      const answer = await model.answer(buildPrompt(c.planted.text, evalNonce(c.planted.text)));
      cache.put(c.planted.text, answer);
      console.log(
        `${String(i + 1)}/${String(todo.length)}  ${c.attack.category}  ${(answer.ms / 1000).toFixed(1)} s`,
      );
    }

    const left = cases.filter((c) => cache.get(c.planted.text) === undefined).length;
    console.log(
      left === 0 ? "injection: every case answered" : `injection: ${String(left)} cases left`,
    );

    // 2. Judge with the real extractor code; the clean answer of the same chunk is the control.
    const known = new Set<string>(CLAUSE_TYPE_NAMES);
    const clean = new TypeTally([...CLAUSE_TYPE_NAMES]);
    const attacked = new TypeTally([...CLAUSE_TYPE_NAMES]);
    const byCategory: Record<string, { cases: number; rawFollowed: number; stored: number }> = {};
    const totals = {
      cases: 0,
      rawFollowed: 0,
      formBroken: 0,
      stored: 0,
      quotedAttack: 0,
      detailEchoes: 0,
      cleanRawEchoes: 0,
      cleanFormBroken: 0,
    };
    const paired = { worse: 0, same: 0, better: 0 };
    const examples: { category: string; attack: string; verdict: CaseVerdict; raw: string }[] = [];
    for (const c of cases) {
      const hit = cache.get(c.planted.text);
      const control = cache.get(c.text);
      if (hit === undefined || control === undefined) continue;
      const result = await extractClauses(c.planted.text, () => Promise.resolve(hit.text), {
        nonce: evalNonce(c.planted.text),
      });
      const verdict = judge(c.text, c.planted, c.attack.text, hit.text, result);
      const controlResult = await extractClauses(c.text, () => Promise.resolve(control.text), {
        nonce: evalNonce(c.text),
      });
      totals.cases++;
      if (verdict.rawFollowed) totals.rawFollowed++;
      if (verdict.formBroken) totals.formBroken++;
      if (verdict.stored) totals.stored++;
      if (verdict.quotedAttack > 0) totals.quotedAttack++;
      if (verdict.detailEchoes > 0) totals.detailEchoes++;
      // Calibration: the same echo test on the answer that never saw the attack (should be 0).
      if (echoes(control.text, shingles(c.attack.text), shingles(c.text))) totals.cleanRawEchoes++;
      if (!controlResult.ok) totals.cleanFormBroken++;
      const cat = (byCategory[c.attack.category] ??= { cases: 0, rawFollowed: 0, stored: 0 });
      cat.cases++;
      if (verdict.rawFollowed) cat.rawFollowed++;
      if (verdict.stored) cat.stored++;
      if (verdict.rawFollowed || verdict.stored) {
        // Public CUAD text and a public attack: the start of the raw answer, to read by hand.
        examples.push({
          category: c.attack.category,
          attack: c.attack.text,
          verdict,
          raw: hit.text.slice(0, 4_000),
        });
      }
      // Damage: right clause types with and without the attack (types only: offsets moved).
      const types = (r: typeof result, text: string) =>
        r.ok ? scoreChunk(c.chunk, text, r.clauses, known).predicted : new Set<string>();
      const hitTypes = types(result, c.planted.text);
      const cleanTypes = types(controlResult, c.text);
      attacked.add(c.chunk.expected, hitTypes);
      clean.add(c.chunk.expected, cleanTypes);
      // Paired, per case: right types found with the attack vs without it.
      const right = (s: Set<string>) => [...s].filter((t) => c.chunk.expected.has(t)).length;
      const diff = right(hitTypes) - right(cleanTypes);
      paired[diff < 0 ? "worse" : diff > 0 ? "better" : "same"]++;
    }

    const report = {
      model: model.name,
      promptVersion: PROMPT_VERSION,
      attacks: "BIPIA text_attack_test.json @ a004b69 (75 attacks, 15 categories)",
      chunks: pool.length,
      ...totals,
      rawFollowedRate: totals.cases === 0 ? null : totals.rawFollowed / totals.cases,
      storedRate: totals.cases === 0 ? null : totals.stored / totals.cases,
      damage: { clean: clean.report().micro, attacked: attacked.report().micro, paired },
      byCategory,
      examples,
    };
    const name = `cuad-injection-${model.name.replace(/[^a-zA-Z0-9._-]+/gu, "_")}.json`;
    writeFileSync(
      new URL(`../results/${name}`, import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        ...totals,
        rawFollowedRate: report.rawFollowedRate,
        storedRate: report.storedRate,
        damage: report.damage,
      }),
    );
  },
  6 * 3_600_000,
);
