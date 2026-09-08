import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compactSuiteCache, readSuiteCache, writeSuiteCache, SUITE_CACHE_MAX_BYTES,
  SUITE_CACHE_MAX_ENTRIES, SUITE_CACHE_READ_MAX_BYTES } from '../lib/runtime/suite-cache.js';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive:true,force:true}))); });
async function cacheFile() {
  const dir=await mkdtemp(path.join(tmpdir(),'ape-cache-retention-')); directories.push(dir);
  return path.join(dir,'suite-cache.json');
}
const entry = (index, extra={}) => ({passed:true,result_hash:`result-${index}`,
  recorded_at:new Date(Date.UTC(2026,0,1)+index*1000).toISOString(),
  verification:{passed:true,exit_code:0,output:'verbose '.repeat(25000)},...extra});

describe('bounded suite-cache retention', () => {
  it('evicts oldest entries and strips raw output while preserving failure classification', () => {
    const results=Object.fromEntries(Array.from({length:SUITE_CACHE_MAX_ENTRIES+20},(_,index)=>[`key-${index}`,entry(index)]));
    results.failure=entry(1000,{passed:false,verification:{passed:false,exit_code:1,tooling_failure:false,timed_out:false,output:'old raw output'}});
    const cache=compactSuiteCache({results});
    expect(Object.keys(cache.results)).toHaveLength(SUITE_CACHE_MAX_ENTRIES);
    expect(cache.results['key-0']).toBeUndefined();
    expect(cache.results['key-275'].verification).not.toHaveProperty('output');
    expect(cache.results.failure).toMatchObject({passed:false,result_hash:'result-1000',verification:{exit_code:1,tooling_failure:false,timed_out:false}});
    expect(Buffer.byteLength(JSON.stringify(cache,null,2))+1).toBeLessThanOrEqual(SUITE_CACHE_MAX_BYTES);
  });

  it('also bounds bytes when many entries contain large commands', async () => {
    const file=await cacheFile();
    const results=Object.fromEntries(Array.from({length:300},(_,index)=>[`key-${index}`,entry(index,{command:'x'.repeat(8192)})]));
    const written=await writeSuiteCache(file,{results});
    expect(Object.keys(written.results).length).toBeLessThan(SUITE_CACHE_MAX_ENTRIES);
    expect((await stat(file)).size).toBeLessThanOrEqual(SUITE_CACHE_MAX_BYTES);
    expect(written.results['key-299']).toBeDefined();
  });

  it('migrates a readable old cache once without losing same-tree failure evidence', async () => {
    const file=await cacheFile();
    await writeFile(file,JSON.stringify({schema_version:'2.0.0',results:{old:entry(1,{passed:false,verification:{passed:false,tooling_failure:true,timed_out:true,output:'v'.repeat(200000)}})}}));
    const first=await readSuiteCache(file);
    expect(first.results.old.verification).toEqual({passed:false,tooling_failure:true,timed_out:true});
    const bytes=await readFile(file,'utf8');
    expect(bytes.length).toBeLessThan(1000);
    expect(await readSuiteCache(file)).toEqual(first);
    expect(await readFile(file,'utf8')).toBe(bytes);
  });

  it('treats oversized, corrupt, and contradictory cached passes as misses', async () => {
    const file=await cacheFile();
    await writeFile(file,' '.repeat(SUITE_CACHE_READ_MAX_BYTES+1));
    expect((await readSuiteCache(file)).results).toEqual({});
    await writeFile(file,'{broken');
    expect((await readSuiteCache(file)).results).toEqual({});
    await writeFile(file,JSON.stringify({results:{bad:entry(1,{verification:{passed:false,exit_code:1}})}}));
    expect((await readSuiteCache(file)).results).toEqual({});
  });
});
