import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { mock } from 'node:test'
import { spawnSync } from 'child_process'
import { createResourceMonitor } from '../src/arsi/resources.mjs'
import { runNodeProc } from '../src/domain/proc.mjs'
import { initProject } from '../src/tools/initProject.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//計時器相關函數之觀察回調 opt.onTrace(排程第 477 項 ①; 規則 R-PKG-8; 跨套件規格〈計時器相關函數之觀察回調與測試〉P1 ~ P5):
//  三處計時器 —— src/arsi/resources.mjs(背景取樣之 setInterval、資源閘之輪詢睡眠)、src/domain/proc.mjs(子行程逾時之 setTimeout)、src/tools/waitEvent.mjs 之本體 src/arsi/waitEnd.mjs(事件檔與鎖檔之輪詢)
//  測試以「等某事件發生」為同步點(不以延時後斷言); 時間本身是規格者(取樣間隔、逾時門檻、輪詢間隔)以假時鐘(node:test 之 mock.timers)驗證; 防懸置之上限用模組載入時保存之真實 setTimeout
let realSetTimeout = setTimeout
let realClearTimeout = clearTimeout

//tracer, 收集事件並提供「等第 n 個某類事件」之同步點(已發生者立即解析; 逾 10 秒未見即拒絕,以免缺陷版整案懸置)
let tracer = () => {
    let events = []
    let waiters = []
    let count = (type) => events.filter((e) => e.type === type).length
    let onTrace = (e) => {
        events.push(e)
        for (let w of waiters.slice()) {
            if (count(w.type) >= w.n) {
                waiters.splice(waiters.indexOf(w), 1)
                realClearTimeout(w.timer)
                w.resolve(e)
            }
        }
    }
    let until = (type, n = 1) => new Promise((resolve, reject) => {
        if (count(type) >= n) {
            resolve(events.filter((e) => e.type === type)[n - 1])
            return
        }
        let w = { type, n, resolve }
        w.timer = realSetTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1)
            reject(new Error(`未見第 ${n} 個「${type}」事件; 已有: ${events.map((e) => e.type).join(',')}`))
        }, 10000)
        waiters.push(w)
    })
    return { events, onTrace, until, types: () => events.map((e) => e.type), count }
}
//各事件之欄位(type 之外)之全集: 事件為凍結物件、欄位皆為原始值(數字、字串、布林、null)、不含 Error 與內部可變參照; 欄位名稱不得為 type
let ALLOWED = {
    'start': ['sampleSec'],
    'stop': [],
    'sample': ['cpu', 'ramUsedGB'],
    'wait-pass': ['tag', 'waitedSec', 'forced', 'limited'],
    'wait-forced': ['tag', 'waitedSec', 'forced'],
    'wait-block': ['tag', 'cpu', 'ramUsedGB'],
    'wait-poll': ['tag', 'cpu', 'ramUsedGB', 'sleepMs'],
    'spawn': ['pid', 'timeoutMs'],
    'timeout': ['timeoutMs'],
    'exit': ['code'],
    'error': ['message'],
    'poll': ['events', 'running', 'sawLock'],
    'round-done': [],
    'recheck': [],
    'sleep': ['ms'],
    'end': ['code', 'event'],
}
let assertContract = (events) => {
    for (let e of events) {
        assert(Object.isFrozen(e), `${e.type}: 事件為凍結物件`)
        assert(e.type in ALLOWED, `未列之事件類型 ${e.type}`)
        assert.deepEqual(Object.keys(e).filter((k) => k !== 'type').sort(), [...ALLOWED[e.type]].sort(), `${e.type}: 欄位`)
        for (let [k, v] of Object.entries(e)) {
            assert(v === null || ['number', 'string', 'boolean'].includes(typeof v), `${e.type}.${k}: 原始值(${typeof v})`)
        }
    }
}
//假取樣: 依序給定各次之 CPU 使用率(%)與已用記憶體(GB); 換算為累計之 CPU 時間(同 unit-run)
let fakeRead = (rows) => {
    let i = 0
    let total = 0
    let idle = 0
    return () => {
        let r = rows[Math.min(i, rows.length - 1)]
        i++
        total += 100
        idle += 100 - r.cpu
        return { cpuTimes: { idle, total }, ramUsedGB: r.ram }
    }
}
let noSleep = () => Promise.resolve()
//onTrace 之「不合」之值: 未給、null、非函數(字串、數字、物件、布林)⇒ 行為與未給者相同
let BAD_TRACE = [undefined, null, 'x', 42, {}, true]
//waitRun, 動態匯入 waitRunEnd 後呼叫(於修前之複本中無此模組 ⇒ 各案各自失敗, 不因一個匯入錯誤使整檔無從區分)
let waitRun = async (opts) => (await import('../src/arsi/waitEnd.mjs')).waitRunEnd(opts)

describe('資源監看與資源閘之觀察回調 opt.onTrace(createResourceMonitor)', function () {
    this.timeout(60000)
    let ROWS = [{ cpu: 50, ram: 80 }, { cpu: 90, ram: 80 }, { cpu: 90, ram: 81 }, { cpu: 30, ram: 79 }]
    let mon = (extra = {}) => createResourceMonitor({ cpuMax: 70, ramUsedMaxGB: 110, read: fakeRead(ROWS), sleep: noSleep, ...extra })
    afterEach(() => {
        mock.timers.reset()
    })

    it('資源閘: 取樣超過門檻 ⇒ 阻塞 → 每次重查前一事件 → 回到門檻內放行;事件序列與內容(逐次取樣之值、睡眠毫秒數、放行之等待秒數與 forced)', async () => {
        let tr = tracer()
        let r = await mon({ onTrace: tr.onTrace }).wait('n1')
        assert.deepEqual(tr.types(), ['sample', 'sample', 'wait-block', 'wait-poll', 'sample', 'wait-poll', 'sample', 'wait-pass'])
        assertContract(tr.events)
        let smp = tr.events.filter((e) => e.type === 'sample')
        assert.deepStrictEqual(smp.map((e) => (e.cpu === null ? null : Math.round(e.cpu))), [null, 90, 90, 30], '各次取樣之 CPU(第一次無值)')
        assert.deepEqual(smp.map((e) => e.ramUsedGB), [80, 80, 81, 79])
        let blk = tr.events.find((e) => e.type === 'wait-block')
        assert.deepEqual([blk.tag, Math.round(blk.cpu), blk.ramUsedGB], ['n1', 90, 80], '阻塞時之值(一次等待只發一次)')
        assert.deepEqual(tr.events.filter((e) => e.type === 'wait-poll').map((e) => [e.tag, e.sleepMs]), [['n1', 10000], ['n1', 10000]], '每次重查前; 睡眠之毫秒數')
        let pass = tr.events[tr.events.length - 1]
        assert.deepEqual([pass.tag, pass.forced, pass.limited, pass.waitedSec], ['n1', false, true, r.waitedSec], '放行: 與回傳值一致')
        assert.equal(r.forced, false)
    })

    it('資源閘: 睡眠之毫秒數 = 事件之 sleepMs(含抖動; 事件與實際交給 sleep 之值相同); 未設上限者立即放行 ⇒ 一個放行事件(limited: false)而無取樣', async () => {
        let tr = tracer()
        let slept = []
        await mon({
            onTrace: tr.onTrace,
            pollSec: 10,
            jitter: 0.6,
            rand: () => 1,
            sleep: (ms) => {
                slept.push(ms); return Promise.resolve()
            }
        }).wait('j')
        let polls = tr.events.filter((e) => e.type === 'wait-poll').map((e) => e.sleepMs)
        assert.deepEqual(polls, [13000, 13000], '10000 × (1 + 0.6 × (1 - 0.5))')
        assert.deepEqual(slept.filter((x) => x !== 1000), polls, '事件之毫秒數 = 交給 sleep 之值(取樣前之 1000 毫秒除外)')
        let tr2 = tracer()
        let r2 = await createResourceMonitor({ read: fakeRead(ROWS), sleep: noSleep, onTrace: tr2.onTrace }).wait('free')
        assert.deepEqual(r2, { waitedSec: 0, forced: false })
        assert.deepEqual(tr2.events, [{ type: 'wait-pass', tag: 'free', waitedSec: 0, forced: false, limited: false }], '未設上限: 只有放行事件')
    })

    it('資源閘: 等待逾最長時間 ⇒ 放行並發 wait-forced(forced: true);其前之取樣事件在', async () => {
        let tr = tracer()
        let r = await createResourceMonitor({ cpuMax: 70, ramUsedMaxGB: 110, maxWaitSec: 0, read: fakeRead([{ cpu: 95, ram: 120 }]), sleep: noSleep, onTrace: tr.onTrace }).wait('f')
        assert.deepEqual(tr.types(), ['sample', 'sample', 'wait-forced'])
        assertContract(tr.events)
        assert.equal(r.forced, true)
        assert.deepEqual([tr.events[2].tag, tr.events[2].forced, tr.events[2].waitedSec], ['f', true, r.waitedSec])
    })

    it('背景取樣(假時鐘): start ⇒ start 與立即一次取樣;每經 sampleSec 一次取樣;stop ⇒ stop 事件且其後不再取樣;重複 start / stop 不重複發事件;stop 後可再 start', async () => {
        mock.timers.enable({ apis: ['setInterval'] })
        let tr = tracer()
        let m = createResourceMonitor({ sampleSec: 5, read: fakeRead([{ cpu: 10, ram: 1 }]), sleep: noSleep, onTrace: tr.onTrace })
        m.start()
        m.start()
        assert.deepStrictEqual(tr.events.map((e) => [e.type, e.sampleSec]), [['start', 5], ['sample', undefined]], '開始: start 一次與立即之取樣; 重複 start 不再發')
        mock.timers.tick(4999)
        assert.equal(tr.count('sample'), 1, '未到間隔不取樣')
        mock.timers.tick(1)
        assert.equal(tr.count('sample'), 2, '滿 5 秒一次')
        mock.timers.tick(10000)
        assert.equal(tr.count('sample'), 4, '再 10 秒 = 兩次')
        m.stop()
        m.stop()
        assert.equal(tr.count('stop'), 1, 'stop 一次(重複 stop 不再發)')
        let n = tr.events.length
        mock.timers.tick(60000)
        assert.equal(tr.events.length, n, 'stop 之後不再有任何事件(假時鐘推進 60 秒)')
        m.start()
        assert.deepEqual(tr.types().slice(n), ['start', 'sample'], 'stop 後可再 start')
        m.stop()
        assertContract(tr.events)
        assert.equal(m.stats().samples, 4, '統計不受回調影響')
    })

    it('事件之約定(P4): 回調拋錯(同步)或回傳被拒之 Promise ⇒ 忽略、不改變結果與統計、不產生未處理之 rejection', async () => {
        let base = mon()
        let r0 = await base.wait('x')
        let unhandled = []
        let onUnhandled = (e) => unhandled.push(e)
        process.on('unhandledRejection', onUnhandled)
        try {
            for (let onTrace of [() => {
                throw new Error('boom')
            }, () => Promise.reject(new Error('rejected')), async () => {
                throw new Error('async boom')
            }]) {
                let m = mon({ onTrace })
                assert.deepEqual(await m.wait('x'), r0)
                assert.deepEqual(m.stats(), base.stats())
            }
            //否定斷言(短暫之觀察窗): 讓出一輪事件迴圈, 未處理之 rejection 若有則已發出
            await new Promise((resolve) => setImmediate(resolve))
            assert.deepEqual(unhandled, [], '無未處理之 rejection')
        }
        finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('未傳回調時行為不變(P3): onTrace 未給、null、非函數(字串、數字、物件、布林)⇒ 回傳值、統計、睡眠之呼叫與未支援前相同', async () => {
        let ref = mon()
        let r0 = await ref.wait('x')
        let s0 = ref.stats()
        for (let v of BAD_TRACE) {
            let slept = []
            let m = mon({
                ...(v === undefined ? {} : { onTrace: v }),
                sleep: (ms) => {
                    slept.push(ms); return Promise.resolve()
                }
            })
            assert.deepEqual(await m.wait('x'), r0, `onTrace = ${String(v)}`)
            assert.deepEqual(m.stats(), s0)
            assert.deepEqual(slept, [1000, 10000, 10000], '睡眠之呼叫(取樣前 1 秒、其後每次重查之間隔)')
        }
    })
})

describe('子行程逾時之觀察回調 opt.onTrace(runNodeProc)', function () {
    this.timeout(120000)
    let t
    before(() => {
        t = makeTmp('timerTraceProc')
    })
    after(() => {
        t.cleanup()
    })
    afterEach(() => {
        mock.timers.reset()
    })
    //子行程之腳本: 自行於 20 秒後結束(假時鐘使逾時不會真發生時, 不致遺留行程)
    let HANG = ['-e', 'setTimeout(() => {}, 20000)']

    it('正常結束: spawn 事件(pid 為數字、帶逾時門檻)→ exit 事件(離開碼);結果與事件一致;事件為凍結之原始值', async () => {
        let tr = tracer()
        let r = await runNodeProc(['-e', 'process.exit(3)'], { cwd: t.dir, timeoutMs: 60000, onTrace: tr.onTrace })
        assert.deepEqual(tr.types(), ['spawn', 'exit'])
        assertContract(tr.events)
        assert.equal(typeof tr.events[0].pid, 'number')
        assert.equal(tr.events[0].timeoutMs, 60000)
        assert.equal(tr.events[1].code, 3)
        assert.deepEqual([r.code, r.timeout], [3, false])
    })

    it('逾時(假時鐘): 於 spawn 事件後推進時間 ⇒ 差 1 毫秒不逾時、滿門檻即 timeout 事件並終止子行程(結果 timeout: true);其後不再有事件', async () => {
        mock.timers.enable({ apis: ['setTimeout'] })
        let tr = tracer()
        let p = runNodeProc(HANG, { cwd: t.dir, timeoutMs: 60000, onTrace: tr.onTrace })
        await tr.until('spawn')
        mock.timers.tick(59999)
        assert.equal(tr.count('timeout'), 0, '差 1 毫秒不逾時')
        mock.timers.tick(1)
        assert.equal(tr.count('timeout'), 1, '滿門檻 ⇒ timeout 事件')
        let r = await p
        assert.deepStrictEqual([r.code, r.timeout], [null, true])
        assert.deepEqual(tr.types(), ['spawn', 'timeout'], '逾時者不發 exit')
        assert.equal(tr.events[1].timeoutMs, 60000)
        assertContract(tr.events)
    })

    it('逾時門檻之前已結束 ⇒ 計時器已清除: 其後推進假時鐘不再有 timeout 事件(否定斷言於假時鐘下確定)', async () => {
        mock.timers.enable({ apis: ['setTimeout'] })
        let tr = tracer()
        let r = await runNodeProc(['-e', '0'], { cwd: t.dir, timeoutMs: 1000, onTrace: tr.onTrace })
        assert.deepEqual([r.code, r.timeout], [0, false])
        mock.timers.tick(5000)
        assert.deepEqual(tr.types(), ['spawn', 'exit'])
    })

    it('子行程起不來(工作目錄不存在): 只有 error 事件(帶訊息字串), 不發 spawn; 結果之 error 同訊息', async () => {
        let tr = tracer()
        let r = await runNodeProc(['-e', '0'], { cwd: path.join(t.dir, 'no-such-dir'), timeoutMs: 60000, onTrace: tr.onTrace })
        assert.deepEqual(tr.types(), ['error'])
        assertContract(tr.events)
        assert.equal(tr.events[0].message, r.error)
        assert(r.error.length > 0)
        assert.deepStrictEqual([r.code, r.timeout], [null, false])
        //spawn 同步拋出(引數型別不合: cwd 非字串)⇒ 同樣只有 error 事件、結果帶 error(不拋出)
        let tr2 = tracer()
        let r2 = await runNodeProc(['-e', '0'], { cwd: 123, timeoutMs: 60000, onTrace: tr2.onTrace })
        assert.deepEqual(tr2.types(), ['error'])
        assert.equal(tr2.events[0].message, r2.error)
        assert.deepStrictEqual([r2.code, r2.timeout], [null, false])
    })

    it('回調拋錯 / 回傳被拒之 Promise ⇒ 忽略、結果不變; 未傳回調(未給、null、非函數)⇒ 結果與未支援前相同', async () => {
        let ref = await runNodeProc(['-e', 'console.log("ok"); process.exit(2)'], { cwd: t.dir, timeoutMs: 60000 })
        assert.deepEqual([ref.code, ref.timeout, ref.out.trim()], [2, false, 'ok'])
        for (let onTrace of [() => {
            throw new Error('boom')
        }, () => Promise.reject(new Error('rejected')), ...BAD_TRACE]) {
            let r = await runNodeProc(['-e', 'console.log("ok"); process.exit(2)'], { cwd: t.dir, timeoutMs: 60000, ...(onTrace === undefined ? {} : { onTrace }) })
            assert.deepEqual([r.code, r.timeout, r.out.trim()], [2, false, 'ok'], String(onTrace))
        }
    })
})

describe('等待一次執行結束之觀察回調 opt.onTrace(waitRunEnd; tools/waitEvent.mjs 之本體)', function () {
    this.timeout(180000)
    let t
    before(() => {
        t = makeTmp('timerTraceWait')
    })
    after(() => {
        t.cleanup()
    })
    afterEach(() => {
        mock.timers.reset()
    })
    let SINCE = Date.parse('2026-01-01T00:00:00Z')
    let ev = (event, at = '2026-02-01T00:00:00Z', more = {}) => ({ event, at, ...more })
    //h, 注入之時間與讀取: 時鐘、事件檔、鎖檔、睡眠(由測試於收到 sleep 事件後放行)皆受測試控制
    let h = (o = {}) => {
        let state = { events: [], lock: { running: false }, lockFile: false, clock: 0, ...o }
        let sleeps = []
        let printed = []
        let tr = tracer()
        let base = { fpEvents: 'E', fpLock: 'L', since: SINCE, timeoutMs: 1000, pollMs: 50, now: () => state.clock, readEvents: () => state.events.slice(), peekRunLock: () => state.lock, existsSync: () => state.lockFile, sleep: (ms) => new Promise((resolve) => sleeps.push({ ms, resolve })), print: (s) => printed.push(s) }
        return { state, sleeps, printed, tr, base, opts: (extra = {}) => ({ ...base, onTrace: tr.onTrace, ...extra }) }
    }
    let release = (x) => x.sleeps.shift().resolve()

    it('等到結束事件: 鎖在行程 ⇒ poll(running)→ sleep(pollMs);其間出現 round-done 與 run-done ⇒ 印 ROUND 與 END、回 0;事件序列 poll, sleep, round-done, end', async () => {
        let x = h({ lock: { running: true, pid: 7 } })
        let p = waitRun(x.opts())
        await x.tr.until('sleep')
        assert.deepEqual(x.tr.types(), ['poll', 'sleep'])
        assert.deepEqual(x.tr.events[0], { type: 'poll', events: 0, running: true, sawLock: true })
        assert.equal(x.tr.events[1].ms, 50)
        x.state.events = [ev('round-done', '2026-02-01T00:00:00Z', { round: 1 }), ev('run-done')]
        release(x)
        assert.equal(await p, 0)
        assert.deepEqual(x.tr.types(), ['poll', 'sleep', 'round-done', 'end'])
        assert.deepEqual(x.tr.events[3], { type: 'end', code: 0, event: 'run-done' })
        assert.deepEqual(x.printed, [`ROUND ${JSON.stringify(ev('round-done', '2026-02-01T00:00:00Z', { round: 1 }))}`, `END ${JSON.stringify(ev('run-done'))}`])
        assertContract(x.tr.events)
    })

    it('since 之前之事件不算; 第一次讀即有結束事件 ⇒ 不輪詢(只有 end); run-failed 回 1、skipped 回 3、各印 END', async () => {
        let x = h({ events: [ev('run-done', '2025-12-31T23:59:59Z')], lock: { running: true } })
        let p = waitRun(x.opts())
        await x.tr.until('sleep')
        assert.equal(x.tr.events[0].events, 0, 'since 之前之事件被濾掉')
        x.state.events = [ev('run-done', '2025-12-31T23:59:59Z'), ev('run-failed')]
        release(x)
        assert.equal(await p, 1)
        assert.deepEqual(x.tr.events.at(-1), { type: 'end', code: 1, event: 'run-failed' })
        for (let [name, code] of [['run-done', 0], ['skipped', 3], ['run-failed', 1]]) {
            let y = h({ events: [ev(name)] })
            assert.equal(await waitRun(y.opts()), code, name)
            assert.deepEqual(y.tr.types(), ['end'], `${name}: 不輪詢`)
            assert.deepEqual(y.printed, [`END ${JSON.stringify(ev(name))}`])
        }
    })

    it('鎖檔之行程已不在: 曾見其在而其後不在 ⇒ recheck + 睡 1500 毫秒再讀; 仍無結束事件 ⇒ vanished(回 5, 印 END vanished); 復查期間出現結束事件 ⇒ 回該事件之碼', async () => {
        for (let late of [false, true]) {
            let x = h({ lock: { running: true } })
            let p = waitRun(x.opts())
            await x.tr.until('sleep')
            x.state.lock = { running: false }
            release(x)
            await x.tr.until('recheck')
            await x.tr.until('sleep', 2)
            assert.deepEqual(x.tr.events.filter((e) => e.type === 'sleep').map((e) => e.ms), [50, 1500], '輪詢之間隔、復查之 1500')
            if (late) {
                x.state.events = [ev('run-done')]
            }
            release(x)
            let code = await p
            if (late) {
                assert.equal(code, 0)
                assert.deepEqual(x.tr.events.at(-1), { type: 'end', code: 0, event: 'run-done' })
            }
            else {
                assert.equal(code, 5)
                assert.deepEqual(x.tr.events.at(-1), { type: 'end', code: 5, event: 'vanished' })
                assert(x.printed.at(-1).startsWith('END {"event":"vanished","detail":"執行之行程已不在而事件檔無結束事件'), x.printed.at(-1))
            }
            assertContract(x.tr.events)
        }
    })

    it('逾時: 時鐘過 timeoutMs ⇒ 回 4, 印 END timeout(含 running 與 pid); 鎖檔存在而從未見行程在者不算異常結束(復查後續輪詢直到逾時)', async () => {
        let x = h({ lock: { running: true, pid: 123 } })
        let p = waitRun(x.opts())
        await x.tr.until('sleep')
        x.state.clock = 1001
        release(x)
        assert.equal(await p, 4)
        assert.deepEqual(x.tr.events.at(-1), { type: 'end', code: 4, event: 'timeout' })
        assert.equal(x.printed.at(-1), `END ${JSON.stringify({ event: 'timeout', running: true, pid: 123 })}`)
        //鎖檔存在、行程不在、從未見其在: 復查(1500)後不判 vanished, 照常輪詢; 逾時回 4
        let y = h({ lockFile: true })
        let q = waitRun(y.opts())
        await y.tr.until('sleep', 1)
        assert.deepEqual(y.tr.types(), ['poll', 'recheck', 'sleep'])
        release(y)
        await y.tr.until('sleep', 2)
        assert.deepEqual(y.tr.events.filter((e) => e.type === 'sleep').map((e) => e.ms), [1500, 50], '復查之 1500、其後之輪詢間隔')
        y.state.clock = 5000
        release(y)
        await y.tr.until('sleep', 3)
        release(y)
        assert.equal(await q, 4)
        assert.equal(y.printed.at(-1), `END ${JSON.stringify({ event: 'timeout', running: false, pid: null })}`)
        assert(!y.tr.events.some((e) => e.type === 'end' && e.event === 'vanished'))
    })

    it('預設之睡眠與時鐘(假時鐘): 逾時門檻 100 毫秒、輪詢 50 毫秒 ⇒ 三次輪詢睡眠後逾時(第三次推進後 150 > 100); 睡眠之毫秒數 = 事件之 ms', async () => {
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
        let tr = tracer()
        let printed = []
        let p = waitRun({ fpEvents: 'E', fpLock: 'L', since: SINCE, timeoutMs: 100, pollMs: 50, readEvents: () => [], peekRunLock: () => ({ running: false }), existsSync: () => false, print: (s) => printed.push(s), onTrace: tr.onTrace })
        for (let k = 1; k <= 3; k++) {
            await tr.until('sleep', k)
            mock.timers.tick(50)
        }
        assert.equal(await p, 4)
        assert.deepEqual(tr.types(), ['poll', 'sleep', 'poll', 'sleep', 'poll', 'sleep', 'poll', 'end'])
        assert.deepEqual(tr.events.filter((e) => e.type === 'sleep').map((e) => e.ms), [50, 50, 50])
        assert.deepEqual(printed, [`END ${JSON.stringify({ event: 'timeout', running: false, pid: null })}`])
    })

    it('回調之約定: 拋錯 / 回傳被拒之 Promise ⇒ 忽略、結果不變; 未傳回調(未給、null、非函數)⇒ 輸出與離開碼與未支援前相同; 事件為凍結之原始值', async () => {
        //事件檔一開始即有 round-done 與 run-done ⇒ 不輪詢; 每個事件(round-done、end)之回調皆拋錯 / 回傳被拒 / 不合
        let run = async (extra) => {
            let x = h({ lock: { running: true }, events: [ev('round-done'), ev('run-done')] })
            return { code: await waitRun({ ...x.base, ...extra }), printed: x.printed }
        }
        let ref = await run({})
        assert.equal(ref.code, 0)
        for (let onTrace of [() => {
            throw new Error('boom')
        }, () => Promise.reject(new Error('rejected')), ...BAD_TRACE]) {
            let r = await run(onTrace === undefined ? {} : { onTrace })
            assert.deepEqual(r, ref, String(onTrace))
        }
    })

    it('tools/waitEvent.mjs 之接線(命令列實跑): 事件檔已有 round-done 與 run-done ⇒ 印 ROUND、END(逐字)、離開碼 0; skipped ⇒ 3; run-failed ⇒ 1; since 之後才算', () => {
        let root = path.join(t.dir, 'proj')
        fs.mkdirSync(root, { recursive: true })
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'proj', version: '1.0.0', private: true }), 'utf8')
        initProject({ root })
        let fdLogs = path.join(root, 'rsi', 'logs')
        fs.mkdirSync(fdLogs, { recursive: true })
        let run = (events, extra = []) => {
            fs.writeFileSync(path.join(fdLogs, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'waitEvent.mjs'), '--since', '2026-01-01T00:00:00Z', '--timeout-min', '1', '--poll-sec', '2', ...extra], { cwd: root, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 60000 })
            return { status: r.status, out: String(r.stdout).split(/\r?\n/).filter(Boolean), err: String(r.stderr) }
        }
        let rd = ev('round-done', '2026-02-01T00:00:00Z', { round: 1 })
        let r1 = run([rd, ev('run-done')])
        assert.equal(r1.status, 0, r1.err.slice(0, 300) + r1.out.join('|'))
        assert.deepEqual(r1.out, [`ROUND ${JSON.stringify(rd)}`, `END ${JSON.stringify(ev('run-done'))}`])
        assert.equal(run([ev('skipped')]).status, 3)
        assert.equal(run([ev('run-failed')]).status, 1)
        //since 之前之結束事件不算(此處另有 since 之後之 run-done ⇒ 以之為準)
        let r4 = run([ev('run-failed', '2025-06-01T00:00:00Z'), ev('run-done', '2026-03-01T00:00:00Z')])
        assert.equal(r4.status, 0)
        assert.deepEqual(r4.out, [`END ${JSON.stringify(ev('run-done', '2026-03-01T00:00:00Z'))}`])
    })
})

