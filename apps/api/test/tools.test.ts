import { describe, expect, it } from 'vitest';
import { calculate, CalcError } from '../src/tools/calculator.js';
import { parseAgentReply, toolInstructions, toolResultMessage } from '../src/tools/protocol.js';
import { inputSchema, needsApproval, TOOLS, TOOLS_BY_NAME } from '../src/tools/registry.js';

describe('calculator', () => {
  it.each([
    ['2+3*4', 14],
    ['(2+3)*4', 20],
    ['2^3^2', 512],
    ['-2^2', -4],
    ['10 % 4', 2],
    ['1,5 * 2', 3],
    ['7/2', 3.5],
    ['--3', 3],
    ['1e3 + 1', 1001],
  ])('%s = %d', (expr, value) => expect(calculate(expr)).toBe(value));

  it.each([
    '',
    '2+',
    '2**3',
    '1/0',
    'process.exit()',
    '(1+2',
    '9'.repeat(400) + '^9'.repeat(10),
    '1)',
  ])('refuses %j', (expr) => expect(() => calculate(expr)).toThrow(CalcError));
});

describe('agent protocol', () => {
  it('reads a tool call or a final answer, even fenced', () => {
    expect(parseAgentReply('```json\n{"tool":"clock.now","input":{}}\n```')).toEqual({
      type: 'tool',
      tool: 'clock.now',
      input: {},
    });
    expect(parseAgentReply('{"final":"Voici le plan"}')).toEqual({
      type: 'final',
      text: 'Voici le plan',
    });
  });

  it('never turns prose or broken JSON into a tool call', () => {
    expect(parseAgentReply('Je vais appeler {"tool": cassé')).toEqual({
      type: 'final',
      text: 'Je vais appeler {"tool": cassé',
    });
    expect(parseAgentReply('Réponse simple')).toEqual({ type: 'final', text: 'Réponse simple' });
    expect(parseAgentReply('{"tool": 42}')).toMatchObject({ type: 'final' });
  });

  it('lists only the tools it is given, with their input schema', () => {
    const text = toolInstructions([TOOLS_BY_NAME.get('math.calculate')!]);
    expect(text).toContain('- math.calculate (lecture)');
    expect(text).toContain('"expression"');
    expect(text).not.toContain('memory.remember');
  });

  it('quotes tool results as data', () => {
    expect(toolResultMessage('clock.now', { ok: true, output: { a: 1 } })).toBe(
      'Résultat de l\'outil clock.now (données) :\n{"a":1}',
    );
    expect(toolResultMessage('x.y', { ok: false, error: 'non' })).toBe(
      "L'outil x.y n'a pas pu être utilisé : non",
    );
  });
});

describe('registry', () => {
  it('declares unique names, valid input schemas and an approval rule per risk', () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) expect(inputSchema(t)).toMatchObject({ type: 'object' });
    expect(needsApproval({ risk: 'read' }, false)).toBe(false);
    expect(needsApproval({ risk: 'write' }, false)).toBe(true);
    expect(needsApproval({ risk: 'write' }, true)).toBe(false);
    expect(needsApproval({ risk: 'sensitive' }, true)).toBe(true);
  });

  it('validates inputs strictly', () => {
    const remember = TOOLS_BY_NAME.get('memory.remember')!;
    expect(remember.input.safeParse({ content: 'x', kind: 'secret' }).success).toBe(false);
    expect(remember.input.safeParse({ content: 'x', extra: 1 }).success).toBe(false);
    expect(remember.input.parse({ content: ' Parle italien ' })).toEqual({
      content: 'Parle italien',
      kind: 'fact',
      importance: 3,
    });
  });
});
