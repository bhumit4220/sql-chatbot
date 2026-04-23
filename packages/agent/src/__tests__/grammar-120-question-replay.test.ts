import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN = process.env.RUN_120_REPLAY === '1';

interface QuestionFixture {
  id: string;
  app: string;
  dbUrl: string;
  question: string;
  correctnessCriteria: {
    verifySQL: string;
    resultShape: string;
  };
}

interface ReplayResult {
  id: string;
  app: string;
  grammarMatched: boolean;
  correct: boolean;
  error?: string;
}

async function runOneQuestion(_fx: QuestionFixture): Promise<ReplayResult> {
  // Full implementation requires:
  // 1. Spin up an Orchestrator connected to fx.dbUrl
  // 2. Run the real Django/Rails introspector if manifest exists, else schema-only
  // 3. Send fx.question through orchestrator.handleQuestion
  // 4. Collect events, check for grammar_matched
  // 5. Parse the executed SQL result
  // 6. Run fx.correctnessCriteria.verifySQL against the same DB to get truth
  // 7. Compare chatbot result vs truth using resultShape-aware matcher
  //
  // Populated alongside the full 120-question fixture.
  throw new Error('live replay not yet implemented — requires running DBs + real LLM key');
}

function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = String(item[key]);
    (out[k] ||= []).push(item);
  }
  return out;
}

(RUN ? describe : describe.skip)('120-question realistic replay (live DB + LLM)', () => {
  const fixturesPath = path.resolve(__dirname, './fixtures/realistic-120-questions.json');
  const fixturesFile = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  const fixtures: QuestionFixture[] = fixturesFile.questions;

  it('reports grammar hit rate and accuracy per app', async () => {
    if (fixtures.length < 120) {
      console.warn(`[replay] fixture only has ${fixtures.length} questions — target is 120 across 4 apps (30 each).`);
    }

    const results: ReplayResult[] = [];
    for (const fx of fixtures) {
      try {
        const r = await runOneQuestion(fx);
        results.push(r);
      } catch (e) {
        results.push({ id: fx.id, app: fx.app, grammarMatched: false, correct: false, error: (e as Error).message });
      }
    }

    const byApp = groupBy(results, 'app');
    console.log('\n--- 120-Question Replay Results ---');
    for (const [app, rs] of Object.entries(byApp)) {
      const hits = rs.filter(r => r.grammarMatched).length;
      const correct = rs.filter(r => r.correct).length;
      const errors = rs.filter(r => r.error).length;
      console.log(`${app}: grammar hits ${hits}/${rs.length}, correct ${correct}/${rs.length}, errors ${errors}`);
    }

    const total = results.length;
    const totalCorrect = results.filter(r => r.correct).length;
    const totalHits = results.filter(r => r.grammarMatched).length;
    console.log(`\nTotal: ${totalCorrect}/${total} correct (${(totalCorrect / total * 100).toFixed(1)}%), grammar hits ${totalHits}/${total} (${(totalHits / total * 100).toFixed(1)}%)`);

    // Acceptance criteria per spec §12:
    // - ≥65% accuracy (minimum; target 69%+)
    // - ≥35% grammar hit rate
    expect(totalCorrect / total).toBeGreaterThanOrEqual(0.65);
    expect(totalHits / total).toBeGreaterThanOrEqual(0.35);
  }, 600000);
});

describe('120-question fixture structure', () => {
  const fixturesPath = path.resolve(__dirname, './fixtures/realistic-120-questions.json');
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

  it('has valid structure with questions array', () => {
    expect(fixtures).toHaveProperty('version');
    expect(fixtures).toHaveProperty('questions');
    expect(Array.isArray(fixtures.questions)).toBe(true);
  });

  it('each question has required fields', () => {
    for (const q of fixtures.questions) {
      expect(q).toHaveProperty('id');
      expect(q).toHaveProperty('app');
      expect(q).toHaveProperty('question');
      expect(q).toHaveProperty('correctnessCriteria');
      expect(q.correctnessCriteria).toHaveProperty('verifySQL');
    }
  });

  it('covers all 4 target apps', () => {
    const apps = new Set(fixtures.questions.map((q: any) => q.app));
    expect(apps.has('saleor')).toBe(true);
    expect(apps.has('chatwoot')).toBe(true);
    expect(apps.has('gitea')).toBe(true);
    expect(apps.has('redmine')).toBe(true);
  });
});
