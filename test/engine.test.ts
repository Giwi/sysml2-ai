import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceEngine } from '../src/engine/engine.ts';
import { readWorkspaceFile, tempWorkspace, writeWorkspaceFile, BASE_MODEL } from './helpers.ts';

test('rename updates qualified references and commits atomically', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const before = engine.index().revision;

  const tx = engine.beginTransaction({ actor: 'test' });
  const result = tx.renameElement({ qname: 'Vehicle::Chassis', newName: 'Frame' });
  assert.equal(result.qname, 'Vehicle::Frame');
  assert.equal(result.details?.referencesUpdated, 1);
  assert.equal(tx.validate().valid, true);

  const commit = await tx.commit();
  assert.notEqual(commit.revision, before);
  assert.equal(engine.index().entryFor('Vehicle::Frame')?.sym.kind, 'Part Definition');
  assert.equal(engine.index().entryFor('Vehicle::Chassis'), undefined);
  assert.equal(engine.index().incomingFor('Vehicle::Frame').length, 1);

  const text = await readWorkspaceFile(ws.dir, 'model.sysml');
  assert.match(text, /part chassis : Frame;/);
  assert.doesNotMatch(text, /Chassis/);
});

test('create element inside a package produces valid SysML', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);

  const tx = engine.beginTransaction({ actor: 'test' });
  tx.createElement({
    uri: 'model.sysml',
    parentQname: 'Vehicle',
    kind: 'requirement def',
    name: 'SafetyRequirement',
    body: 'attribute text : String = "The vehicle shall brake.";',
    doc: 'Added by test',
  });
  const commit = await tx.commit();
  assert.equal(commit.diagnostics.valid, true);
  const entry = engine.index().entryFor('Vehicle::SafetyRequirement');
  assert.equal(entry?.sym.kind, 'Requirement Definition');
  assert.match(await readWorkspaceFile(ws.dir, 'model.sysml'), /requirement def SafetyRequirement/);
});

test('create element expands a semicolon parent into a body', async (t) => {
  const ws = await tempWorkspace({ 'model.sysml': 'package P {\n    part def Empty;\n}\n' });
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tx = engine.beginTransaction({ actor: 'test' });
  tx.createElement({ uri: 'model.sysml', parentQname: 'P::Empty', kind: 'attribute', name: 'mass' });
  await tx.commit();
  assert.ok(engine.index().entryFor('P::Empty::mass'));
});

test('duplicate names are rejected before touching disk', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tx = engine.beginTransaction({ actor: 'test' });
  assert.throws(
    () => tx.createElement({ uri: 'model.sysml', parentQname: 'Vehicle', kind: 'part def', name: 'Chassis' }),
    (error: unknown) => {
      assert.equal((error as { error: { code: string } }).error.code, 'NAME_COLLISION');
      assert.match((error as Error).message, /already exists/);
      return true;
    }
  );
  tx.rollback();
  assert.match(await readWorkspaceFile(ws.dir, 'model.sysml'), /part def Chassis/);
});

test('delete refuses referenced elements and accepts unreferenced ones', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);

  const refused = engine.beginTransaction({ actor: 'test' });
  assert.throws(
    () => refused.deleteElement({ qname: 'Vehicle::Chassis' }),
    (error: unknown) => (error as { error: { code: string } }).error.code === 'REFERENCED_ELEMENT'
  );
  refused.rollback();

  const tx = engine.beginTransaction({ actor: 'test' });
  tx.deleteElement({ qname: 'Vehicle::MassVerification' });
  await tx.commit();
  assert.equal(engine.index().entryFor('Vehicle::MassVerification'), undefined);
});

test('invalid transaction rolls back and leaves the file unchanged', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const before = await readWorkspaceFile(ws.dir, 'model.sysml');
  const tx = engine.beginTransaction({ actor: 'test' });
  tx.replaceText({
    type: 'replace',
    uri: 'model.sysml',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
    text: 'package ???',
  });
  await assert.rejects(tx.commit(), (error: unknown) => {
    assert.equal((error as { error: { code: string } }).error.code, 'VALIDATION_FAILED');
    return true;
  });
  tx.rollback();
  assert.equal(await readWorkspaceFile(ws.dir, 'model.sysml'), before);
});

test('optimistic concurrency reports a revision conflict', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tx1 = engine.beginTransaction({ actor: 'a' });
  const tx2 = engine.beginTransaction({ actor: 'b' });

  tx1.renameElement({ qname: 'Vehicle::Chassis', newName: 'Frame' });
  await tx1.commit();

  tx2.renameElement({ qname: 'Vehicle::Chassis', newName: 'Body' });
  await assert.rejects(tx2.commit(), (error: unknown) => {
    const structured = (error as { error: { code: string; retryable: boolean } }).error;
    assert.equal(structured.code, 'REVISION_CONFLICT');
    assert.equal(structured.retryable, true);
    return true;
  });
});

test('syntax errors invalidate validation and are structured', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  await writeWorkspaceFile(ws.dir, 'model.sysml', `${BASE_MODEL}\npackage Broken { part def ???; }`);
  const engine = await WorkspaceEngine.open(ws.dir);
  const report = engine.validate();
  assert.equal(report.valid, false);
  assert.ok(report.errors.count > 0);
  assert.equal(report.errors.items[0].code, 'SYNTAX_ERROR');
  assert.ok(report.errors.items[0].range);
});

test('delete removes the whole declaration including its keyword', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const create = engine.beginTransaction({ actor: 'test' });
  create.createElement({ uri: 'model.sysml', parentQname: 'Vehicle', kind: 'part def', name: 'Temporary' });
  await create.commit();
  const before = await readWorkspaceFile(ws.dir, 'model.sysml');
  assert.match(before, /part def Temporary;/);

  const tx = engine.beginTransaction({ actor: 'test' });
  tx.deleteElement({ qname: 'Vehicle::Temporary' });
  const commit = await tx.commit();
  assert.equal(engine.index().entryFor('Vehicle::Temporary'), undefined);
  const after = await readWorkspaceFile(ws.dir, 'model.sysml');
  assert.doesNotMatch(after, /Temporary/);
  assert.doesNotMatch(after, /part def\s*;/);
  assert.ok(commit.changedFiles[0].removed > 0);
});

test('rename updates references across files in one transaction', async (t) => {
  const ws = await tempWorkspace({
    'a.sysml': 'package P { part def A; }\n',
    'b.sysml': 'package Q { import P::*; part b : A; }\n',
  });
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tx = engine.beginTransaction({ actor: 'test' });
  tx.renameElement({ qname: 'P::A', newName: 'B' });
  const commit = await tx.commit();
  assert.equal(commit.changedFiles.length, 2);
  assert.equal(engine.index().entryFor('P::B')?.sym.kind, 'Part Definition');
  assert.match(await readWorkspaceFile(ws.dir, 'b.sysml'), /part b : B;/);
});

test('rollback discards pending operations', async (t) => {
  const ws = await tempWorkspace();
  t.after(ws.cleanup);
  const engine = await WorkspaceEngine.open(ws.dir);
  const tx = engine.beginTransaction({ actor: 'test' });
  tx.renameElement({ qname: 'Vehicle::Chassis', newName: 'Frame' });
  assert.equal(tx.validate().valid, true);
  tx.rollback();
  assert.equal(engine.index().entryFor('Vehicle::Chassis')?.sym.kind, 'Part Definition');
});
