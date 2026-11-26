import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { runRounds, resolveRunConfig, acquireRunLock, peekRunLock, appendEvent, readEvents, trailingFailures } from '../src/arsi/runner.mjs'
import { runNodeProc } from '../src/domain/proc.mjs'
import { archiveExperience, archiveFeedback } from '../src/domain/archiveDocs.mjs'
import { makeDispatch, checkQuota } from '../src/arsi/dispatchers.mjs'
import { createResourceMonitor } from '../src/arsi/resources.mjs'
import { createFileRecords } from '../src/arsi/records.mjs'
import { createArsi } from '../src/arsi/arsi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//聚合入口匯出之函數之 opt 與必給件之檢測(排程第 477 項 ④之餘項 4 ~ 6、11、12; R-EV-54 ②③④⑤): 跨套件規格〈輸入參數之檢測機制〉
//  V4(opt 本身: null、undefined 視為未給; 其他非一般物件無效)、K3(其餘選填 opt 給了而無效 ⇒ 用預設)、§3.7(計時值: 無效用預設)、§5.1(必給件以固定訊息拒絕, 不拋原生 TypeError; 失敗通道依入口類別:
//    工廠與同步且有副作用者 ⇒ 同步拋; 回傳 Promise 者 ⇒ reject; 回傳結果物件者 ⇒ 回失敗之結果)、V19(訊息格式)、V20(不回顯輸入值)
//  規格之句 ⇒ 案: 「先於任何副作用」= 檢查後無檔案、無子行程、無回調被呼叫; 「不回顯」= 以祕密字樣為無效之值; 「合法輸入之行為不變」= 各 describe 末之對照案
let SECRET = 'secret-token-xyz'
let NOTOBJ = ['x', 5, true, [], [1], () => 1]

describe('入口之 opt 與必給件之檢測(R-EV-54 ② ③ ④ ⑤)', function () {
    this.timeout(300000)
    let t = makeTmp('inputOpt')
    after(() => t.cleanup())
    let sub = (n) => path.join(t.dir, `${n}_${Math.random().toString(36).slice(2, 7)}`)
    let throwsMsg = (fn, want, label) => {
        let err = null
        try {
            fn()
        }
        catch (e) {
            err = e
        }
        assert.ok(err !== null, `${label}: 應拋`)
        assert.strictEqual(String(err.message), want, label)
        assert.ok(!String(err.message).includes(SECRET), `${label}: 不回顯`)
    }
    let rejectsMsg = async (fn, want, label) => {
        let err = null
        try {
            await fn()
        }
        catch (e) {
            err = e
        }
        assert.ok(err !== null, `${label}: 應 reject`)
        assert.ok(err instanceof Error && !(err instanceof TypeError), `${label}: 固定訊息之 Error, 非原生 TypeError(${String(err && err.message).slice(0, 80)})`)
        assert.strictEqual(String(err.message), want, label)
        assert.ok(!String(err.message).includes(SECRET), `${label}: 不回顯`)
    }

    describe('runRounds(多輪執行之驅動; 回傳 Promise ⇒ reject)', () => {
        let ok = () => ({ index: 0 })
        it('opt 非一般物件 ⇒ reject invalid opt: must be an object; opt 為 undefined、null、runRound 非函數 ⇒ reject invalid opt.runRound: must be a function(原: 原生 TypeError); 先於任何一輪(runRound 未被呼叫)', async () => {
            let calls = 0
            let spy = () => {
                calls++
                return {}
            }
            for (let v of NOTOBJ) {
                await rejectsMsg(() => runRounds(v), 'invalid opt: must be an object', `opt ${typeof v}`)
            }
            for (let v of [undefined, null]) {
                await rejectsMsg(() => runRounds(v), 'invalid opt.runRound: must be a function', `opt ${String(v)}`)
            }
            for (let v of [undefined, null, 'x', 5, {}, []]) {
                await rejectsMsg(() => runRounds({ runRound: v }), 'invalid opt.runRound: must be a function', `runRound ${typeof v}`)
            }
            await rejectsMsg(() => runRounds({ runRound: spy, rounds: 'abc' }), 'invalid opt.rounds: must be a non-negative integer', 'rounds')
            assert.strictEqual(calls, 0, '無任何一輪被執行')
        })
        it('rounds(規模; 與 --rounds 同一量)給了而無效(true、false、小數、負數、非數字字串、空字串、物件、陣列、NaN、Infinity、BigInt)⇒ reject invalid opt.rounds: must be a non-negative integer(原: true ⇒ 1 輪、2.5 ⇒ 3 輪、abc ⇒ 0 輪仍成功)', async () => {
            let n = 0
            for (let v of [true, false, 2.5, -1, 'abc', '', ' ', {}, [], [1], NaN, Infinity, -Infinity, 10n, '1.5', '0x10']) {
                let calls = 0
                let runRound = () => {
                    calls++
                    return {}
                }
                await rejectsMsg(() => runRounds({ rounds: v, runRound }), 'invalid opt.rounds: must be a non-negative integer', `rounds ${typeof v === 'bigint' ? 'BigInt' : JSON.stringify(v)}`)
                assert.strictEqual(calls, 0)
                n++
            }
            assert(n >= 16)
        })
        it('rounds: 未給(undefined、null)= 1 輪; 非負整數與其數字字串照用(0 = 不跑; \'3\' = 3 輪); 合法輸入之結果不變(done、stopped)', async () => {
            let cnt = async (rounds, extra = {}) => {
                let n = 0
                let runRound = async ({ index }) => {
                    n++
                    return { index }
                }
                let r = await runRounds({ rounds, runRound, ...extra })
                return { n, r }
            }
            assert.strictEqual((await cnt(undefined)).n, 1)
            assert.strictEqual((await cnt(null)).n, 1)
            assert.strictEqual((await cnt(0)).n, 0)
            assert.deepStrictEqual((await cnt(0)).r, { done: [], stopped: null })
            assert.strictEqual((await cnt(3)).n, 3)
            assert.strictEqual((await cnt('3')).n, 3)
            assert.strictEqual((await cnt(' 2 ')).n, 2)
            let h = await runRounds({ rounds: 3, runRound: async ({ index }) => ({ index, halt: index === 1 ? '停' : null }) })
            assert.deepStrictEqual(h, { done: [{ index: 0, halt: null }, { index: 1, halt: '停' }], stopped: '停' })
            let s = await runRounds({ rounds: 5, shouldStop: ({ index }) => (index === 2 ? '額度' : null), runRound: ok })
            assert.strictEqual(s.done.length, 2)
            assert.strictEqual(s.stopped, '額度')
        })
        it('shouldStop(停止之閘)給了而非函數 ⇒ reject invalid opt.shouldStop: must be a function(原: 靜默無閘、null 為 TypeError); onRoundDone、log(觀察用)非函數 ⇒ 視為未給(K3)', async () => {
            for (let v of ['x', 5, true, {}, []]) {
                await rejectsMsg(() => runRounds({ shouldStop: v, runRound: ok }), 'invalid opt.shouldStop: must be a function', `shouldStop ${typeof v}`)
            }
            for (let v of ['x', 5, true, {}, [], null, undefined]) {
                let r = await runRounds({ rounds: 2, onRoundDone: v, log: v, runRound: ok })
                assert.strictEqual(r.done.length, 2, `onRoundDone / log ${typeof v}`)
            }
            let seen = []
            await runRounds({ rounds: 2, onRoundDone: (res, c) => seen.push([c.index, c.rounds]), runRound: ok })
            assert.deepEqual(seen, [[0, 2], [1, 2]])
            let shouldStopNull = await runRounds({ rounds: 2, shouldStop: null, runRound: ok })
            assert.strictEqual(shouldStopNull.done.length, 2, 'shouldStop: null = 未給')
        })
    })

    describe('resolveRunConfig(每輪節點數等之解析)', () => {
        it('cfg、cli 為 null 或非物件 ⇒ 視為未給(K3; 原: null 為原生 TypeError); 合法輸入之結果不變', () => {
            assert.deepEqual(resolveRunConfig(null, null), { nodesPerRound: 3, parallelNodes: 3, roundsPerRun: 1 })
            assert.deepEqual(resolveRunConfig('x', 5), { nodesPerRound: 3, parallelNodes: 3, roundsPerRun: 1 })
            assert.deepEqual(resolveRunConfig(undefined, null), { nodesPerRound: 3, parallelNodes: 3, roundsPerRun: 1 })
            assert.deepEqual(resolveRunConfig({ nodesPerRound: 4 }, null), { nodesPerRound: 4, parallelNodes: 4, roundsPerRun: 1 })
            assert.deepEqual(resolveRunConfig(null, { nodesPerRound: 2, parallelNodes: 9, roundsPerRun: '3' }), { nodesPerRound: 2, parallelNodes: 2, roundsPerRun: 3 })
            assert.deepEqual(resolveRunConfig({ nodesPerRound: 4, parallelNodes: 2, roundsPerRun: 2 }, {}), { nodesPerRound: 4, parallelNodes: 2, roundsPerRun: 2 })
        })
    })

    describe('單一執行之鎖、事件檔(runner.mjs)', () => {
        it('acquireRunLock: fpLock 非非空字串 ⇒ 同步拋 invalid fpLock: must be a non-empty string(先於任何副作用); opt 非一般物件 ⇒ 拋 invalid opt: must be an object; opt 為 null 視為未給', () => {
            let d = sub('lockA')
            for (let v of [undefined, null, '', 5, {}, [], true]) {
                throwsMsg(() => acquireRunLock(v), 'invalid fpLock: must be a non-empty string', `fpLock ${typeof v}`)
            }
            for (let v of NOTOBJ) {
                throwsMsg(() => acquireRunLock(path.join(d, 'x.lock'), v), 'invalid opt: must be an object', `opt ${typeof v}`)
            }
            assert.ok(!fs.existsSync(d), '未建任何資料夾或鎖檔')
            let l = acquireRunLock(path.join(d, 'x.lock'), null)
            assert.strictEqual(l.ok, true)
            l.release()
            assert.ok(!fs.existsSync(path.join(d, 'x.lock')), '釋放後無鎖檔')
        })
        it('peekRunLock: fpLock 非非空字串 ⇒ 同步拋(原: 讀檔拋錯被吞 ⇒ running = false ⇒「輪次進行中不得執行」之守門靜默放行); opt 非一般物件 ⇒ 拋; 合法者之結果不變', () => {
            for (let v of [undefined, null, '', 5, {}, []]) {
                throwsMsg(() => peekRunLock(v), 'invalid fpLock: must be a non-empty string', `fpLock ${typeof v}`)
            }
            for (let v of NOTOBJ) {
                throwsMsg(() => peekRunLock(path.join(t.dir, 'none.lock'), v), 'invalid opt: must be an object', `opt ${typeof v}`)
            }
            assert.deepStrictEqual(peekRunLock(path.join(t.dir, 'none.lock'), null), { running: false, stale: false, pid: null, startedAt: null, beatAt: null })
            let fp = path.join(sub('lockB'), 'r.lock')
            let l = acquireRunLock(fp)
            let p = peekRunLock(fp)
            assert.strictEqual(p.running, true)
            assert.strictEqual(p.pid, process.pid)
            l.release()
        })
        it('appendEvent: fpEvents 非非空字串或 obj 非一般物件 ⇒ 回 false、不寫任何檔(原: appendEvent(路徑, "abc") 把字串展開成 { 0: "a", … } 寫入並回 true); 合法者之結果不變', () => {
            let d = sub('evA')
            let fp = path.join(d, 'events.jsonl')
            for (let v of ['abc', 5, null, undefined, [], [1], true, () => 1]) {
                assert.strictEqual(appendEvent(fp, v), false, `obj ${typeof v}`)
            }
            for (let v of [undefined, null, '', 5, {}, []]) {
                assert.strictEqual(appendEvent(v, { event: 'x' }), false, `fp ${typeof v}`)
            }
            assert.ok(!fs.existsSync(d), '未建任何檔')
            assert.strictEqual(appendEvent(fp, { event: 'run-start', n: 1 }), true)
            let rows = readEvents(fp)
            assert.strictEqual(rows.length, 1)
            assert.strictEqual(rows[0].event, 'run-start')
            assert(typeof rows[0].at === 'string' && Number.isFinite(Date.parse(rows[0].at)), '自動帶 at')
        })
        it('readEvents: fpEvents 非非空字串 ⇒ 同步拋(原: 回 [] ⇒ trailingFailures 為 0 ⇒「連續失敗達上限不再自動起跑」之守門靜默放行); 非一般物件之列(null、數字、字串、陣列)與壞列略過; 無檔 ⇒ []', () => {
            for (let v of [undefined, null, '', 5, {}]) {
                throwsMsg(() => readEvents(v), 'invalid fpEvents: must be a non-empty string', `fp ${typeof v}`)
            }
            let fp = path.join(sub('evB'), 'e.jsonl')
            fs.mkdirSync(path.dirname(fp), { recursive: true })
            fs.writeFileSync(fp, ['null', '5', '"str"', '[1,2]', '{"event":"round-done","ok":false}', '{bad json', '', '{"event":"run-failed"}'].join('\n'), 'utf8')
            assert.deepEqual(readEvents(fp), [{ event: 'round-done', ok: false }, { event: 'run-failed' }])
            assert.deepEqual(readEvents(path.join(t.dir, 'no-such.jsonl')), [])
            //含 null 列之事件檔: 連續失敗之計數不再拋原生 TypeError
            assert.strictEqual(trailingFailures(readEvents(fp)), 2)
        })
        it('trailingFailures: events 非陣列 ⇒ 拋 invalid events: must be an array of event objects(原: 非陣列回 0 = 守門靜默放行、null 為 TypeError); 陣列中非一般物件之元素略過(不計、不打斷); 合法者之結果不變', () => {
            for (let v of [undefined, null, 'x', 5, {}, true]) {
                throwsMsg(() => trailingFailures(v), 'invalid events: must be an array of event objects', `events ${typeof v}`)
            }
            let F = { event: 'round-done', ok: false }
            assert.strictEqual(trailingFailures([F, null, 5, 'x', [], F]), 2)
            assert.strictEqual(trailingFailures([F, { event: 'round-done', ok: true }, F]), 1)
            assert.strictEqual(trailingFailures([F, F, { event: 'run-failed' }, { event: 'skipped' }, { event: 'run-start' }]), 3)
            assert.strictEqual(trailingFailures([]), 0)
        })
    })

    describe('runNodeProc(以子行程執行 node 腳本; 回傳結果物件 ⇒ 回失敗之結果; 逾時為計時值 §3.7)', () => {
        let fixed = (error) => ({ code: null, out: '', timeout: false, error })
        it('args 非非空之字串陣列、opt 非一般物件、cwd 給了而非非空字串、env 給了而非一般物件 ⇒ 回失敗之結果(固定訊息、不 spawn、不拋)', async () => {
            let marker = path.join(sub('rn'), 'ran.txt')
            let script = `require('fs').mkdirSync(${JSON.stringify(path.dirname(marker))}, { recursive: true }); require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`
            for (let a of [undefined, null, 'x', 5, {}, [], [1], ['-e', 5], [null]]) {
                assert.deepStrictEqual(await runNodeProc(a, { cwd: t.dir }), fixed('invalid args: must be a non-empty array of strings'), `args ${JSON.stringify(a)}`)
            }
            for (let v of NOTOBJ) {
                assert.deepStrictEqual(await runNodeProc(['-e', script], v), fixed('invalid opt: must be an object'), `opt ${typeof v}`)
            }
            for (let v of ['', 5, {}, [], true]) {
                assert.deepStrictEqual(await runNodeProc(['-e', script], { cwd: v }), fixed('invalid opt.cwd: must be a non-empty string'), `cwd ${typeof v}`)
            }
            for (let v of ['x', 5, [], true]) {
                assert.deepStrictEqual(await runNodeProc(['-e', script], { cwd: t.dir, env: v }), fixed('invalid opt.env: must be an object'), `env ${typeof v}`)
            }
            assert.ok(!fs.existsSync(marker), '子行程未被起動')
        })
        it('失敗之結果亦依觀察回調之約定發 error 事件(只有 error、帶訊息字串、不發 spawn; 事件之訊息 = 結果之 error; 不傳 onTrace 者結果同)', async () => {
            for (let [a, o, want] of [
                [['x', 5], { cwd: t.dir }, 'invalid args: must be a non-empty array of strings'],
                [['-e', '0'], { cwd: 123 }, 'invalid opt.cwd: must be a non-empty string'],
                [['-e', '0'], { cwd: t.dir, env: 'x' }, 'invalid opt.env: must be an object'],
            ]) {
                let ev = []
                let r = await runNodeProc(a, { ...o, onTrace: (e) => ev.push(e) })
                assert.deepEqual(ev.map((e) => e.type), ['error'], want)
                assert.strictEqual(ev[0].message, want)
                assert.strictEqual(r.error, want)
                assert.deepStrictEqual(await runNodeProc(a, o), fixed(want), '不傳 onTrace')
            }
        })
        it('timeoutMs(計時值): 缺或無效(NaN、負數、0、超過 2147483647、非數字、布林、空字串、null)⇒ 用預設 900000(原: 計時器約 1 毫秒觸發而子行程即被終止並回 timeout); 有效者(正數、數字字串)照用; 以 onTrace 之 spawn 事件觀察實際採用之值', async () => {
            let cases = [[undefined, 900000], [null, 900000], [NaN, 900000], [-5, 900000], [0, 900000], [2147483648, 900000], [Infinity, 900000], ['abc', 900000], [true, 900000], ['', 900000], [{}, 900000], [[], 900000], [30000, 30000], ['60000', 60000], [2147483647, 2147483647]]
            for (let [v, want] of cases) {
                let ev = []
                let r = await runNodeProc(['-e', '0'], { cwd: t.dir, timeoutMs: v, onTrace: (e) => ev.push(e) })
                assert.strictEqual(r.code, 0, `timeoutMs ${String(v)}: ${JSON.stringify(r)}`)
                let sp = ev.find((e) => e.type === 'spawn')
                assert(sp, `timeoutMs ${String(v)}: 有 spawn 事件`)
                assert.strictEqual(sp.timeoutMs, want, `timeoutMs ${typeof v === 'number' && Number.isNaN(v) ? 'NaN' : JSON.stringify(v)}`)
            }
            //缺省之呼叫(第二參數 undefined、null)亦用預設; 子行程照常執行
            for (let o of [undefined, null]) {
                let r = await runNodeProc(['-e', 'console.log(42)'], o)
                assert.strictEqual(r.code, 0)
                assert.strictEqual(r.out.trim(), '42')
            }
        })
        it('行為: 無效之 timeoutMs 不再使慢於 1 毫秒之子行程被終止(原: NaN、負數、超過上限皆於約 1 毫秒觸發); 有效之短逾時照常終止(逾時之行為不變)', async () => {
            for (let v of [NaN, -1, 'abc', 2147483648]) {
                let r = await runNodeProc(['-e', 'setTimeout(() => console.log(`late`), 250)'], { cwd: t.dir, timeoutMs: v })
                assert.deepEqual({ code: r.code, timeout: r.timeout, out: r.out.trim() }, { code: 0, timeout: false, out: 'late' }, `timeoutMs ${String(v)}`)
            }
            let r2 = await runNodeProc(['-e', 'setTimeout(() => {}, 20000)'], { cwd: t.dir, timeoutMs: 300 })
            assert.deepStrictEqual({ code: r2.code, timeout: r2.timeout }, { code: null, timeout: true }, '有效之短逾時照常終止')
        })
    })

    describe('archiveExperience、archiveFeedback(專案指引文件之整理; 同步且有副作用 ⇒ 同步拋)', () => {
        //mkExp: n 節、每節之本文為 size 個 ASCII 字元(位元組數可算); 預設 4400 ⇒ 5 節約 22 KB(大於 keepBytes 預設 18000、小於 maxBytes 預設 30000: 使「預設值是否生效」可由是否搬出辨別)
        let mkExp = (d, n = 4, size = 4400) => {
            fs.mkdirSync(d, { recursive: true })
            let fp = path.join(d, 'experience.md')
            let secs = Array.from({ length: n }, (_, i) => `## 第 ${i + 1} 節\n\n${i * 10 + 1}. **標題 ${i + 1}**: ${'x'.repeat(size)}\n`)
            fs.writeFileSync(fp, `# 經驗\n\n${secs.join('\n')}`, 'utf8')
            return fp
        }
        let mkFb = (d, n = 20) => {
            fs.mkdirSync(d, { recursive: true })
            let fp = path.join(d, 'feedback.md')
            fs.writeFileSync(fp, `# 回饋\n\n| 日期 | 內容 |\n|---|---|\n${Array.from({ length: n }, (_, i) => `| 2026-11-${String(i + 1).padStart(2, '0')} | ${'回饋'.repeat(20)}${i} |`).join('\n')}\n`, 'utf8')
            return fp
        }
        it('opt 非一般物件、fp 非非空字串 ⇒ 同步拋 invalid opt / opt.fp: must be …(原: 解構 null 為 TypeError; fp 為 undefined 時 existsSync 回 false 而靜默回 null)', () => {
            for (let fn of [archiveExperience, archiveFeedback]) {
                for (let v of [undefined, null, 'x', 5, []]) {
                    throwsMsg(() => fn(v), 'invalid opt: must be an object', `opt ${String(v)}`)
                }
                for (let v of [undefined, null, '', 5, {}, []]) {
                    throwsMsg(() => fn({ fp: v }), 'invalid opt.fp: must be a non-empty string', `fp ${typeof v}`)
                }
            }
        })
        it('maxBytes: null、0、小數、負數、非數字 ⇒ 視為未給、用預設 30000(K3; 原: null ⇒ 小檔也搬); keepBytes、keepSections、keepRows 同(預設 18000、2、14); date 非有效之 Date ⇒ 用現在(原: 檔名 NaNNaNNaN)', () => {
            for (let v of [null, 0, 2.5, -1, 'abc', true, {}]) {
                let fp = mkExp(sub('arcA'), 5)
                assert(fs.statSync(fp).size > 18000 && fs.statSync(fp).size < 30000, '鑑別前提: 檔大於 keepBytes 預設 18000 而小於 maxBytes 預設 30000(maxBytes 無效而不用預設者會搬)')
                assert.strictEqual(archiveExperience({ fp, maxBytes: v }), null, `經驗 maxBytes ${JSON.stringify(v)}: 未逾預設之 30000 ⇒ 不搬`)
                assert.deepEqual(fs.readdirSync(path.dirname(fp)), ['experience.md'], '未寫其他檔')
                let fb = mkFb(sub('arcB'))
                assert.strictEqual(archiveFeedback({ fp: fb, maxBytes: v }), null, `回饋 maxBytes ${JSON.stringify(v)}: 小檔不搬`)
            }
            //keepSections、keepRows 無效 ⇒ 預設(2 節、14 列): 以小之 maxBytes 觸發整理
            let fp = mkExp(sub('arcC'), 5)
            let r = archiveExperience({ fp, maxBytes: 100, keepBytes: 100, keepSections: 'abc', date: new Date(2026, 10, 23) })
            assert(r && r.file === 'experience_20261123.md', JSON.stringify(r))
            assert.strictEqual(fs.readFileSync(fp, 'utf8').split('\n').filter((l) => /^## 第/.test(l)).length, 2, '保留 2 節(預設)')
            let fb = mkFb(sub('arcD'), 20)
            let r2 = archiveFeedback({ fp: fb, maxBytes: 100, keepRows: -3, date: new Date(2026, 10, 23) })
            assert(r2 && r2.moved === 6, `keepRows 無效 ⇒ 預設 14 列 ⇒ 搬 6 列: ${JSON.stringify(r2)}`)
            //date 無效
            for (let v of ['2026-11-23', 5, NaN, new Date('x'), {}]) {
                let f2 = mkExp(sub('arcE'), 4)
                let r3 = archiveExperience({ fp: f2, maxBytes: 100, keepBytes: 100, date: v })
                assert(r3 && /^experience_\d{8}\.md$/.test(r3.file) && !r3.file.includes('NaN'), `date ${String(v)}: ${r3 && r3.file}`)
            }
        })
        it('keepBytes 無效或未給 ⇒ 預設 18000: 主檔搬出一節後之大小夾在 17000 與 18000 之間, 預設者只搬一節、給 17000 者搬兩節(使預設值可辨)', () => {
            let kept = (fp) => fs.readFileSync(fp, 'utf8').split('\n').filter((l) => /^## 第/.test(l)).length
            let probe = mkExp(sub('arcH'), 5)
            let text = fs.readFileSync(probe, 'utf8')
            let afterOne = Buffer.byteLength(text) - Buffer.byteLength(text.slice(text.indexOf('## 第 1 節'), text.indexOf('## 第 2 節')))
            assert(afterOne > 17000 && afterOne <= 18000, `鑑別前提: 搬出一節後 ${afterOne} 位元組`)
            for (let v of [undefined, null, 'abc', -1, 2.5, true, '18000']) {
                let fp = mkExp(sub('arcI'), 5)
                let r = archiveExperience({ fp, maxBytes: 100, keepBytes: v, keepSections: 1 })
                assert(r && r.moved === 1, `keepBytes ${JSON.stringify(v)}: ${JSON.stringify(r)}`)
                assert.strictEqual(kept(fp), 4, `keepBytes ${JSON.stringify(v)}: 預設 18000 ⇒ 搬一節(留 4 節)`)
            }
            let fp17 = mkExp(sub('arcJ'), 5)
            archiveExperience({ fp: fp17, maxBytes: 100, keepBytes: 17000, keepSections: 1 })
            assert.strictEqual(kept(fp17), 3, 'keepBytes 17000 ⇒ 搬兩節(留 3 節)')
        })
        it('數字字串轉為數值後使用(K7); 有效之 Date 原樣; 合法輸入之結果不變', () => {
            let fp = mkExp(sub('arcF'), 5)
            let r = archiveExperience({ fp, maxBytes: '100', keepBytes: ' 100 ', keepSections: '3', date: new Date(2026, 0, 2) })
            assert(r && r.file === 'experience_20260102.md', JSON.stringify(r))
            assert.strictEqual(fs.readFileSync(fp, 'utf8').split('\n').filter((l) => /^## 第/.test(l)).length, 3, 'keepSections \'3\' ⇒ 3 節')
            assert.strictEqual(archiveExperience({ fp: path.join(t.dir, 'none.md') }), null, '無檔 ⇒ null')
        })
    })

    describe('makeDispatch、checkQuota(派工與額度)', () => {
        let mkWda = (log) => ({
            providers: [
                { id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' },
                { id: 'oc:opencode/m-free', kind: 'opencode', provider: 'opencode', model: 'opencode/m-free' },
            ],
            readEnvFile: () => ({ OPENCODE_GO_KEYS: 'oc_sk_TESTKEY00000001' }),
            opencodeGoUsage: async () => ({ ok: true, limited: false, usage: { weekly: { percent: 99, resetsAt: '2026-01-05T00:00:00.000Z' } } }),
            dispatchOpencode: async (prompt, opts) => {
                log.push({ fn: 'dispatchOpencode', timeoutMs: opts.timeoutMs })
                return { ok: false, errorType: 'quota', error: 'Free usage limit reached', stdout: '', durationMs: 1 }
            },
            dispatchClaude: async () => {
                log.push({ fn: 'dispatchClaude' })
                return { ok: true, stdout: 'x', durationMs: 1 }
            },
            getQuotaClaude: async () => ({ ok: true, windows: [] }),
        })
        let AG = () => ({ node: { kind: 'opencode', id: 'ocgo:opencode-go/m', fallback: [{ kind: 'opencode', id: 'oc:opencode/m-free' }] } })
        let envFile = path.join(t.dir, 'dummy.env')
        before(() => fs.writeFileSync(envFile, 'x=1\n', 'utf8'))

        it('makeDispatch: opt、agents 非一般物件、skillsRoot 非非空字串(給 inject.wda 者除外)⇒ 同步拋固定訊息(原: 原生 TypeError)', () => {
            for (let v of [undefined, null, ...NOTOBJ]) {
                throwsMsg(() => makeDispatch(v), 'invalid opt: must be an object', `opt ${String(v)}`)
            }
            for (let v of [undefined, null, 'x', 5, [], true]) {
                throwsMsg(() => makeDispatch({ agents: v, skillsRoot: 'x', inject: { wda: mkWda([]) } }), 'invalid opt.agents: must be an object', `agents ${String(v)}`)
            }
            for (let v of [undefined, null, '', 5, {}]) {
                throwsMsg(() => makeDispatch({ agents: AG(), skillsRoot: v }), 'invalid opt.skillsRoot: must be a non-empty string', `skillsRoot ${String(v)}`)
            }
            assert.strictEqual(typeof makeDispatch({ agents: AG(), inject: { wda: mkWda([]) } }), 'function', '給 inject.wda 者 skillsRoot 可省')
        })
        it('makeDispatch: cwd(agent 之工作根; 其下 edit / write / bash 皆放行)給了而非非空字串 ⇒ 拋 invalid opt.cwd: must be a non-empty string(複審 #7); 未給(undefined、null)與合格之字串照常', () => {
            for (let v of ['', 5, {}, [], true]) {
                throwsMsg(() => makeDispatch({ agents: AG(), skillsRoot: 'x', cwd: v, inject: { wda: mkWda([]) } }), 'invalid opt.cwd: must be a non-empty string', `cwd ${typeof v}`)
            }
            for (let v of [undefined, null, t.dir]) {
                assert.strictEqual(typeof makeDispatch({ agents: AG(), skillsRoot: 'x', cwd: v, inject: { wda: mkWda([]) } }), 'function', `cwd ${String(v)}`)
            }
        })
        it('agents.<role>: 非一般物件、kind 非 opencode 或 claude(原: 靜默走 opencode 分支)、fallback 非物件之陣列(原: 展開時 TypeError)、fallback 項之 kind 不合 ⇒ 同步拋(角色名只在為 \\w{1,20} 時寫出); 未設定之角色(undefined、null、false)略過', () => {
            let mk = (cfg) => () => makeDispatch({ agents: { node: cfg }, skillsRoot: 'x', inject: { wda: mkWda([]) } })
            for (let v of ['x', 5, true, []]) {
                throwsMsg(mk(v), 'invalid opt.agents.node: must be an object', `agent ${typeof v}`)
            }
            for (let v of ['codex', 'Claude', 5, true, {}]) {
                throwsMsg(mk({ kind: v }), 'invalid opt.agents.node.kind: must be one of opencode, claude', `kind ${JSON.stringify(v)}`)
            }
            for (let v of [{}, 'x', 5, true, [1], [null], ['x']]) {
                throwsMsg(mk({ kind: 'claude', fallback: v }), 'invalid opt.agents.node.fallback: must be an array of objects', `fallback ${JSON.stringify(v)}`)
            }
            throwsMsg(mk({ kind: 'claude', fallback: [{ kind: 'x' }] }), 'invalid opt.agents.node.fallback[].kind: must be one of opencode, claude', 'fallback kind')
            throwsMsg(() => makeDispatch({ agents: { 'bad role!': 5 }, skillsRoot: 'x', inject: { wda: mkWda([]) } }), 'invalid opt.agents.<role>: must be an object', '角色名不寫出')
            for (let v of [undefined, null, false, 0, '']) {
                assert.doesNotThrow(() => makeDispatch({ agents: { node: v, dream: { kind: 'claude', model: 'm' } }, skillsRoot: 'x', inject: { wda: mkWda([]) } }), `未設定 ${JSON.stringify(v)}`)
            }
            assert.doesNotThrow(mk({ kind: undefined, fallback: null }), 'kind、fallback 未給')
            assert.doesNotThrow(mk({ kind: 'claude', model: 'm', fallback: false }), 'fallback: false = 無備援(同改前之 `|| []`)')
            assert.doesNotThrow(mk({ kind: 'claude', model: 'm', fallback: [] }), 'fallback: []')
        })
        it('派工函數之呼叫: o 非一般物件、prompt 或 logFile 非字串 ⇒ 回 ok: false 之結果(不派工、不寫檔); role 未設定 ⇒ ok: false(同改前)', async () => {
            let log = []
            let d = makeDispatch({ agents: AG(), skillsRoot: 'x', inject: { wda: mkWda(log) } })
            let lf = path.join(sub('dsp'), 'a.log')
            let bad = { ok: false, error: 'invalid opt: must be an object with a string prompt and a non-empty string logFile', agent: {} }
            for (let o of [undefined, null, 'x', 5, [], {}, { prompt: 'p' }, { logFile: lf }, { prompt: 5, logFile: lf }, { prompt: 'p', logFile: '' }, { prompt: 'p', logFile: 5 }]) {
                assert.deepEqual(await d('node', o), bad, JSON.stringify(o))
            }
            assert.deepEqual(log, [], '未派工')
            assert.ok(!fs.existsSync(path.dirname(lf)), '未建日誌夾')
            let none = await d('nobody', { prompt: 'p', logFile: lf })
            assert.strictEqual(none.ok, false)
            assert(/未設定/.test(none.error))
        })
        it('checkQuota: opt、agents 非一般物件、skillsRoot 非非空字串 ⇒ reject 固定訊息; probe(是否實際派一次備援 = 耗用額度)給了而不是 true / false ⇒ reject invalid opt.probe: must be a boolean(原: 以 === true 判 ⇒ \'true\'、1 靜默被當成不探測); 先於任何查詢或探測(替身未被呼叫)', async () => {
            let log = []
            let wda = mkWda(log)
            let base = { agents: AG(), skillsRoot: 'x', envFile, inject: { wda } }
            for (let v of [undefined, null, ...NOTOBJ]) {
                await rejectsMsg(() => checkQuota(v), 'invalid opt: must be an object', `opt ${String(v)}`)
            }
            for (let v of [undefined, null, 'x', 5, [], true]) {
                await rejectsMsg(() => checkQuota({ ...base, agents: v }), 'invalid opt.agents: must be an object', `agents ${String(v)}`)
            }
            for (let v of [undefined, '', 5, {}]) {
                await rejectsMsg(() => checkQuota({ ...base, skillsRoot: v, inject: {} }), 'invalid opt.skillsRoot: must be a non-empty string', `skillsRoot ${String(v)}`)
            }
            for (let v of ['true', 'false', 1, 0, '', {}, [], SECRET]) {
                await rejectsMsg(() => checkQuota({ ...base, probe: v }), 'invalid opt.probe: must be a boolean', `probe ${JSON.stringify(v)}`)
            }
            await rejectsMsg(() => checkQuota({ ...base, agents: { node: { kind: 'codex' } } }), 'invalid opt.agents.node.kind: must be one of opencode, claude', 'kind')
            assert.deepEqual(log, [], '無任何探測')
        })
        it('checkQuota: probeTimeoutMs(計時值 §3.7)缺或無效 ⇒ 預設 60000(原: 不驗 ⇒ NaN、負數使探測之計時器立即觸發); 有效者(正數、數字字串)照用 —— 以實際傳給探測之 timeoutMs 觀察', async () => {
            let cases = [[undefined, 60000], [null, 60000], [NaN, 60000], [-1, 60000], [0, 60000], ['abc', 60000], [2147483648, 60000], [true, 60000], [5000, 5000], ['7000', 7000]]
            for (let [v, want] of cases) {
                let log = []
                let r = await checkQuota({ agents: AG(), skillsRoot: 'x', envFile, probe: true, probeTimeoutMs: v, inject: { wda: mkWda(log) } })
                let probes = log.filter((x) => x.fn === 'dispatchOpencode')
                assert.strictEqual(probes.length, 1, `probeTimeoutMs ${String(v)}: 探測一次(主模型達門檻而有備援)`)
                assert.strictEqual(probes[0].timeoutMs, want, `probeTimeoutMs ${typeof v === 'number' && Number.isNaN(v) ? 'NaN' : JSON.stringify(v)}`)
                assert.strictEqual(r.rows[0].blocked, true, '備援因額度而不可用 ⇒ 擋下(同改前)')
            }
        })
        it('合法輸入之行為不變: probe 為 false 或未給(undefined、null)⇒ 不探測、有備援即不擋; maxPercent 無效者用預設 95(K3)', async () => {
            for (let v of [false, undefined, null]) {
                let log = []
                let r = await checkQuota({ agents: AG(), skillsRoot: 'x', envFile, probe: v, inject: { wda: mkWda(log) } })
                assert.strictEqual(log.length, 0, `probe ${String(v)}: 不探測`)
                assert.strictEqual(r.rows[0].blocked, false)
                assert.strictEqual(r.rows[0].maxPercent, 95)
            }
            let r = await checkQuota({ agents: AG(), skillsRoot: 'x', envFile, maxPercent: 'abc', inject: { wda: mkWda([]) } })
            assert.strictEqual(r.rows[0].maxPercent, 95)
        })
    })

    describe('createResourceMonitor、createFileRecords、createArsi(工廠 ⇒ 同步拋)', () => {
        it('createResourceMonitor: opt 為 null、undefined 視為 {}(原: null 為原生 TypeError); 非一般物件 ⇒ 拋 invalid opt: must be an object; 合法者照常', () => {
            for (let v of [null, undefined]) {
                let m = createResourceMonitor(v)
                assert.strictEqual(typeof m.wait, 'function', `opt ${String(v)}`)
            }
            for (let v of NOTOBJ) {
                throwsMsg(() => createResourceMonitor(v), 'invalid opt: must be an object', `opt ${typeof v}`)
            }
            assert.strictEqual(typeof createResourceMonitor({ cpuMax: 90, ramUsedMaxGB: 24 }).start, 'function')
        })
        it('createFileRecords: opt 非一般物件、nodeDir 或 dreamDir 非非空字串、trashDir 給了而非非空字串 ⇒ 同步拋、先於任何副作用(未建資料夾); 合法者照常', () => {
            let d = sub('rec')
            for (let v of [undefined, null, ...NOTOBJ]) {
                throwsMsg(() => createFileRecords(v), 'invalid opt: must be an object', `opt ${String(v)}`)
            }
            for (let v of [undefined, null, '', 5, {}]) {
                throwsMsg(() => createFileRecords({ nodeDir: v, dreamDir: path.join(d, 'd') }), 'invalid opt.nodeDir: must be a non-empty string', `nodeDir ${String(v)}`)
                throwsMsg(() => createFileRecords({ nodeDir: path.join(d, 'n'), dreamDir: v }), 'invalid opt.dreamDir: must be a non-empty string', `dreamDir ${String(v)}`)
            }
            for (let v of ['', 5, {}, true]) {
                throwsMsg(() => createFileRecords({ nodeDir: path.join(d, 'n'), dreamDir: path.join(d, 'd'), trashDir: v }), 'invalid opt.trashDir: must be a non-empty string', `trashDir ${String(v)}`)
            }
            assert.ok(!fs.existsSync(d), '未建資料夾')
            for (let v of [undefined, null]) {
                let r = createFileRecords({ nodeDir: path.join(d, 'n'), dreamDir: path.join(d, 'd'), trashDir: v })
                r.putDreamDoc({ round: 2, audits: [] })
                assert.strictEqual(r.getDreamDoc(2).round, 2)
            }
        })
        it('createArsi: opt、records、texts(六個任務書函數)、hooks 須為一般物件(hooks 之 null、undefined 視為 {}); dispatch、verify 須為函數; workDir 須為非空字串; gate 給了須為函數、toolbox 給了須為一般物件、artifactFiles 給了須為字串陣列 ⇒ 同步拋固定訊息(原: 原生 TypeError, 於第一次呼叫才現形)', () => {
            let fn = () => ({})
            let texts = { nodeBrief: fn, nodePrompt: fn, nodeTemplate: fn, dreamBrief: fn, dreamPrompt: fn, dreamTemplate: fn }
            let good = () => ({ records: {}, dispatch: fn, verify: fn, texts: { ...texts }, workDir: path.join(t.dir, 'wk') })
            for (let v of [undefined, null, ...NOTOBJ]) {
                throwsMsg(() => createArsi(v), 'invalid opt: must be an object', `opt ${String(v)}`)
            }
            for (let [k, bad, msg] of [
                ['records', [undefined, null, 'x', []], 'invalid opt.records: must be an object'],
                ['dispatch', [undefined, null, 'x', {}], 'invalid opt.dispatch: must be a function'],
                ['verify', [undefined, null, 'x', {}], 'invalid opt.verify: must be a function'],
                ['texts', [undefined, null, 'x', []], 'invalid opt.texts: must be an object'],
                ['workDir', [undefined, null, '', 5, {}], 'invalid opt.workDir: must be a non-empty string'],
                ['hooks', ['x', 5, [], true], 'invalid opt.hooks: must be an object'],
                ['gate', ['x', 5, {}, true], 'invalid opt.gate: must be a function'],
                ['toolbox', ['x', 5, [], true], 'invalid opt.toolbox: must be an object'],
                ['artifactFiles', ['x', 5, {}, [1], [null]], 'invalid opt.artifactFiles: must be an array of strings'],
            ]) {
                for (let v of bad) {
                    throwsMsg(() => createArsi({ ...good(), [k]: v }), msg, `${k} ${JSON.stringify(v)}`)
                }
            }
            for (let k of Object.keys(texts)) {
                for (let v of [undefined, 'x', {}]) {
                    throwsMsg(() => createArsi({ ...good(), texts: { ...texts, [k]: v } }), `invalid opt.texts.${k}: must be a function`, `texts.${k}`)
                }
            }
            //注入之元件可為類別實例(依賴注入; 複審 #5): records、texts、hooks、toolbox 只核對為非 null 之物件; opt 本身仍須為一般物件
            class Rec {}
            class Tx {
                nodeBrief() {}
                nodePrompt() {}
                nodeTemplate() {}
                dreamBrief() {}
                dreamPrompt() {}
                dreamTemplate() {}
            }
            class Hk {
                onNodeDone() {}
            }
            let inst = createArsi({ ...good(), records: new Rec(), texts: new Tx(), hooks: new Hk(), toolbox: new Rec() })
            assert.strictEqual(typeof inst.runNode, 'function', '類別實例之注入')
            throwsMsg(() => createArsi(Object.assign(Object.create({ inherited: 1 }), good())), 'invalid opt: must be an object', 'opt 本身為類別實例 ⇒ 拒收(V4)')
            //合法者: hooks 為 null、undefined 視為 {}; gate、toolbox、artifactFiles、log 之未給與 null; log 非函數視為未給
            for (let extra of [{}, { hooks: null }, { hooks: undefined }, { gate: null }, { toolbox: null }, { artifactFiles: null }, { artifactFiles: ['a.mjs'] }, { log: 'x' }, { log: () => {} }, { hooks: { onNodeDone: () => {} } }]) {
                let a = createArsi({ ...good(), ...extra })
                assert.strictEqual(typeof a.runNode, 'function', JSON.stringify(Object.keys(extra)))
            }
        })
    })
})
