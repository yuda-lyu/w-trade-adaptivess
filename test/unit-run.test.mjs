import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { runRounds, resolveRunConfig, acquireRunLock, peekRunLock, appendEvent, readEvents, trailingFailures } from '../src/arsi/runner.mjs'
import { createResourceMonitor } from '../src/arsi/resources.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//執行規模與資源閘(src/arsi/runner.mjs、src/arsi/resources.mjs 檔頭之規則): 每條斷言對應檔頭之一句
describe('runner:每輪幾個節點、同時幾個、一次跑幾輪', function () {
    it('resolveRunConfig:命令列覆寫優先於設定,設定優先於預設;皆須為正整數;同時執行數不大於每輪節點數', () => {
        assert.deepEqual(resolveRunConfig(), { nodesPerRound: 3, parallelNodes: 3, roundsPerRun: 1 })
        assert.deepEqual(resolveRunConfig({ nodesPerRound: 5, parallelNodes: 2, roundsPerRun: 4 }), { nodesPerRound: 5, parallelNodes: 2, roundsPerRun: 4 })
        assert.deepEqual(resolveRunConfig({ nodesPerRound: 5, parallelNodes: 5, roundsPerRun: 1 }, { nodesPerRound: 8, parallelNodes: null, roundsPerRun: 2 }), { nodesPerRound: 8, parallelNodes: 5, roundsPerRun: 2 })
        //未給同時執行數 ⇒ 等於每輪節點數; 給得比節點數大 ⇒ 壓到節點數
        assert.deepEqual(resolveRunConfig({ nodesPerRound: 4 }), { nodesPerRound: 4, parallelNodes: 4, roundsPerRun: 1 })
        assert.equal(resolveRunConfig({ nodesPerRound: 2, parallelNodes: 9 }).parallelNodes, 2)
        //非正整數者不採用
        assert.deepEqual(resolveRunConfig({ nodesPerRound: 0, parallelNodes: -1, roundsPerRun: 1.5 }, { nodesPerRound: 'x' }), { nodesPerRound: 3, parallelNodes: 3, roundsPerRun: 1 })
    })

    it('runRounds:連跑指定輪數,每輪後呼叫回調;結果依序回傳', async () => {
        let seen = []
        let r = await runRounds({ rounds: 3, runRound: async ({ index }) => ({ n: index }), onRoundDone: (x, c) => seen.push([x.n, c.index, c.rounds]) })
        assert.deepStrictEqual(r, { done: [{ n: 0 }, { n: 1 }, { n: 2 }], stopped: null })
        assert.deepEqual(seen, [[0, 0, 3], [1, 1, 3], [2, 2, 3]])
    })

    it('runRounds:每輪開始前詢問 shouldStop,回非空字串即不再起新輪', async () => {
        let ran = 0
        let r = await runRounds({
            rounds: 5,
            runRound: async () => {
                ran++; return {}
            },
            shouldStop: ({ done }) => (done.length >= 2 ? '停止檔存在' : null)
        })
        assert.equal(ran, 2)
        assert.equal(r.stopped, '停止檔存在')
        let r0 = await runRounds({
            rounds: 2,
            runRound: async () => {
                throw new Error('不應執行')
            },
            shouldStop: () => '一開始就停'
        })
        assert.deepEqual(r0, { done: [], stopped: '一開始就停' })
    })

    it('runRounds:該輪結果之 halt 非空 ⇒ 該輪之回調照做,其後停止', async () => {
        let cb = 0
        let r = await runRounds({
            rounds: 4,
            runRound: async ({ index }) => ({ index, halt: index === 1 ? '輪末回調失敗' : null }),
            onRoundDone: () => {
                cb++
            }
        })
        assert.equal(r.done.length, 2)
        assert.equal(cb, 2)
        assert.equal(r.stopped, '輪末回調失敗')
    })
})

//無人值守(排程器定時觸發同一道起跑指令)所需之三件事(src/arsi/runner.mjs 檔頭; 規則 R-RUN-4): 單一執行之鎖、事件檔、連續失敗之計數
describe('runner:單一執行之鎖與事件檔', function () {
    let t
    let fpLock
    let DEAD = 4206649 //不存在之 pid
    let OTHER = 987654321 //假裝「另一個呼叫者」之 pid(只用於 opt.pid)
    let write = (o) => fs.writeFileSync(fpLock, JSON.stringify(o))
    let read = () => JSON.parse(fs.readFileSync(fpLock, 'utf8'))
    beforeEach(() => {
        t = makeTmp('runLock')
        fpLock = path.join(t.dir, 'logs', 'round.lock')
    })
    afterEach(() => {
        t.cleanup()
    })

    it('acquireRunLock:取得後鎖檔記 pid、起始與心跳;另一個呼叫者於其行程仍在時得 running(不啟動);release 後可再取得', () => {
        let a = acquireRunLock(fpLock)
        assert.equal(a.ok, true)
        let j = read()
        assert.equal(j.pid, process.pid)
        assert(j.startedAt && j.beatAt)
        let b = acquireRunLock(fpLock, { pid: OTHER })
        assert.deepEqual([b.ok, b.why, b.pid, b.startedAt], [false, 'running', process.pid, j.startedAt])
        assert.equal(read().pid, process.pid, '未取得者不得改動鎖檔')
        a.release()
        assert.equal(fs.existsSync(fpLock), false)
        let c = acquireRunLock(fpLock)
        assert.equal(c.ok, true)
        c.release()
    })

    it('acquireRunLock:release 只刪自己的鎖;beat 更新心跳而不改 pid 與起始時間', () => {
        let a = acquireRunLock(fpLock)
        let j0 = read()
        //beat 把心跳改為呼叫當下之時刻: 先把鎖檔之心跳設為已知之過去時刻(pid 與起始照舊), 以狀態而非等待時間判定「已更新」(不依賴時鐘於兩次呼叫之間前進)
        let past = '2000-01-01T00:00:00.000Z'
        write({ ...j0, beatAt: past })
        let tBefore = Date.now()
        a.beat()
        let j1 = read()
        assert.deepEqual([j1.pid, j1.startedAt], [j0.pid, j0.startedAt])
        assert(Date.parse(j1.beatAt) > Date.parse(past), `心跳須更新: ${j1.beatAt}`)
        assert(Date.parse(j1.beatAt) >= tBefore, `心跳須為呼叫當下之時刻(不早於呼叫前): ${j1.beatAt}`)
        //鎖檔已被別人接手(內容之 pid 不是自己)⇒ release 與 beat 皆不動它
        write({ pid: OTHER, startedAt: 'x', beatAt: 'x' })
        a.release()
        a.beat()
        assert.deepEqual(read(), { pid: OTHER, startedAt: 'x', beatAt: 'x' })
    })

    it('acquireRunLock:殘留之鎖(行程已不在、pid 已被別的程式重用、鎖檔損壞)⇒ 接手', () => {
        fs.mkdirSync(path.dirname(fpLock), { recursive: true })
        write({ pid: DEAD, startedAt: new Date().toISOString(), beatAt: new Date().toISOString() })
        let a = acquireRunLock(fpLock)
        assert.equal(a.ok, true, '行程已不在')
        a.release()
        //pid 仍在但已是別的程式(機器重開後 pid 被重用)
        write({ pid: process.pid, startedAt: new Date().toISOString(), beatAt: new Date().toISOString() })
        let b = acquireRunLock(fpLock, { pid: OTHER, isSameProgram: () => false })
        assert.equal(b.ok, true, 'pid 已被別的程式重用')
        assert.equal(read().pid, OTHER)
        fs.rmSync(fpLock)
        fs.writeFileSync(fpLock, '{壞掉')
        let c = acquireRunLock(fpLock)
        assert.equal(c.ok, true, '鎖檔損壞')
        c.release()
    })

    it('acquireRunLock / peekRunLock:行程仍在而心跳逾時 ⇒ stale(不接手,等人處理);peek 只看不動', () => {
        assert.deepStrictEqual(peekRunLock(fpLock), { running: false, stale: false, pid: null, startedAt: null, beatAt: null })
        fs.mkdirSync(path.dirname(fpLock), { recursive: true })
        let old = new Date(Date.now() - 7 * 3600000).toISOString()
        write({ pid: process.pid, startedAt: old, beatAt: old })
        let a = acquireRunLock(fpLock, { pid: OTHER })
        assert.deepEqual([a.ok, a.why, a.pid], [false, 'stale', process.pid])
        assert.equal(read().beatAt, old, '不接手、不改鎖檔')
        let p = peekRunLock(fpLock)
        assert.deepEqual([p.running, p.stale, p.pid], [true, true, process.pid])
        //心跳在時限內 ⇒ running
        assert.equal(acquireRunLock(fpLock, { pid: OTHER, staleMs: 8 * 3600000 }).why, 'running')
        assert.equal(peekRunLock(fpLock, { staleMs: 8 * 3600000 }).stale, false)
        //行程已不在 ⇒ peek 回 running false(鎖檔照留, 由下一次取得者接手)
        write({ pid: DEAD, startedAt: old, beatAt: old })
        assert.equal(peekRunLock(fpLock).running, false)
        assert.equal(fs.existsSync(fpLock), true)
    })

    it('appendEvent / readEvents:每列一個 JSON、自動帶時間、只增;壞列略過;無檔回空陣列', () => {
        let fp = path.join(t.dir, 'logs', 'events.jsonl')
        assert.deepEqual(readEvents(fp), [])
        assert.equal(appendEvent(fp, { event: 'run-start', rounds: 1 }), true)
        fs.appendFileSync(fp, '不是 JSON\n')
        appendEvent(fp, { event: 'run-done', rounds: 1, stopped: null })
        let evs = readEvents(fp)
        assert.deepEqual(evs.map((e) => e.event), ['run-start', 'run-done'])
        assert(evs.every((e) => /^\d{4}-\d{2}-\d{2}T/.test(e.at)))
    })

    it('trailingFailures:自末尾往前數連續失敗之輪(round-done 而 ok 為 false、或 run-failed);未啟動與起訖事件不計也不打斷;遇成功之一輪即止', () => {
        let ok = { event: 'round-done', ok: true }
        let bad = { event: 'round-done', ok: false }
        assert.equal(trailingFailures([]), 0)
        assert.equal(trailingFailures([bad, ok]), 0)
        assert.equal(trailingFailures([ok, bad, { event: 'run-done' }, { event: 'skipped' }, { event: 'run-start' }, bad]), 2)
        assert.equal(trailingFailures([ok, { event: 'run-failed' }, { event: 'skipped' }]), 1)
        assert.equal(trailingFailures([bad, bad, bad]), 3)
    })
})

describe('resources:資源監看與資源閘', function () {
    //假取樣: 依序給定各次之 CPU 使用率(%)與已用記憶體(GB); 換算為累計之 CPU 時間
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

    it('未設任何上限 ⇒ 資源閘立即放行', async () => {
        let m = createResourceMonitor({ read: fakeRead([{ cpu: 99, ram: 999 }]), sleep: noSleep })
        assert.deepEqual(await m.wait('x'), { waitedSec: 0, forced: false })
        assert.deepStrictEqual(m.stats().limits, { cpuMax: null, ramUsedMaxGB: null, cpuStart: null, ramStartGB: null })
    })

    it('起新工作之門檻預設為上限減餘裕(CPU − 15、記憶體 − 8)', () => {
        let m = createResourceMonitor({ cpuMax: 70, ramUsedMaxGB: 110, read: fakeRead([{ cpu: 0, ram: 0 }]) })
        assert.deepEqual(m.stats().limits, { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 55, ramStartGB: 102 })
        let m2 = createResourceMonitor({ cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 40, ramStartGB: 90, read: fakeRead([{ cpu: 0, ram: 0 }]) })
        assert.deepEqual([m2.stats().limits.cpuStart, m2.stats().limits.ramStartGB], [40, 90])
    })

    it('最近取樣超過門檻 ⇒ 等待並重查,回到門檻內才放行;統計記等待次數、最高值與超過上限之取樣數', async () => {
        //第 1 次取樣無 CPU 值(需兩次之差); 其後 90、90 超過門檻 55, 第 4 次 30 放行
        let m = createResourceMonitor({ cpuMax: 70, ramUsedMaxGB: 110, read: fakeRead([{ cpu: 50, ram: 80 }, { cpu: 90, ram: 80 }, { cpu: 90, ram: 81 }, { cpu: 30, ram: 79 }]), sleep: noSleep })
        let r = await m.wait('node a')
        assert.equal(r.forced, false)
        let s = m.stats()
        assert.deepEqual([s.samples, s.cpuPeak, s.overCpu, s.overRam, s.waits, s.forced, s.ramPeakGB], [3, 90, 2, 0, 1, 0, 81])
        assert.equal(s.cpuMean, 70)
    })

    it('jitter:等待時之重查間隔依注入之亂數抖動(多個行程各自等同一門檻時不同時放行);未設則為固定間隔', async () => {
        //resources.mjs 檔頭: jitter 為重查間隔之隨機抖動比例, 間隔 = pollSec × (1 + jitter × (rand − 0.5))
        let slept = []
        let rec = async (ms) => {
            slept.push(ms)
        }
        let m = createResourceMonitor({ cpuMax: 70, pollSec: 10, jitter: 0.6, rand: () => 1, read: fakeRead([{ cpu: 50, ram: 80 }, { cpu: 90, ram: 80 }, { cpu: 90, ram: 80 }, { cpu: 30, ram: 80 }]), sleep: rec })
        await m.wait('eval')
        assert(slept.includes(13000), `重查間隔應為 10 秒 × 1.3: ${JSON.stringify(slept)}`)
        slept.length = 0
        let m2 = createResourceMonitor({ cpuMax: 70, pollSec: 10, read: fakeRead([{ cpu: 50, ram: 80 }, { cpu: 90, ram: 80 }, { cpu: 30, ram: 80 }]), sleep: rec })
        await m2.wait('eval')
        assert(slept.includes(10000) && !slept.includes(13000))
    })

    it('記憶體超過門檻同樣等待', async () => {
        let m = createResourceMonitor({ cpuMax: 70, ramUsedMaxGB: 110, read: fakeRead([{ cpu: 10, ram: 105 }, { cpu: 10, ram: 105 }, { cpu: 10, ram: 100 }]), sleep: noSleep })
        let r = await m.wait('dream')
        assert.equal(r.forced, false)
        assert.equal(m.stats().waits, 1)
    })

    it('等待逾最長時間 ⇒ 放行並記 forced', async () => {
        let m = createResourceMonitor({ cpuMax: 70, ramUsedMaxGB: 110, maxWaitSec: 0, read: fakeRead([{ cpu: 95, ram: 120 }]), sleep: noSleep })
        let r = await m.wait('x')
        assert.equal(r.forced, true)
        let s = m.stats()
        assert.deepEqual([s.forced, s.overRam > 0], [1, true])
    })

    it('統計含逐分鐘之摘要(事後看高點落在哪個階段)', async () => {
        let m = createResourceMonitor({ cpuMax: 70, read: fakeRead([{ cpu: 10, ram: 50 }, { cpu: 40, ram: 60 }, { cpu: 20, ram: 55 }]), sleep: noSleep })
        m.sample()
        m.sample()
        m.sample()
        let s = m.stats()
        assert(s.series.length >= 1)
        let all = s.series
        assert.equal(Math.max(...all.map((b) => b.cpuMax)), 40)
        assert.equal(Math.max(...all.map((b) => b.ramMaxGB)), 60)
        assert(all.every((b) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.t)))
        m.reset()
        assert.deepEqual(m.stats().series, [])
    })

    it('reset:統計歸零(每輪各記一份)', async () => {
        let m = createResourceMonitor({ cpuMax: 70, read: fakeRead([{ cpu: 80, ram: 1 }]), sleep: noSleep, maxWaitSec: 0 })
        await m.wait('x')
        assert(m.stats().samples > 0)
        m.reset()
        let s = m.stats()
        assert.deepStrictEqual([s.samples, s.cpuPeak, s.waits, s.forced, s.overCpu], [0, null, 0, 0, 0])
    })
})
