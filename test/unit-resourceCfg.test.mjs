import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as RN from '../src/arsi/rsiNums.mjs'
import { createResourceMonitor } from '../src/arsi/resources.mjs'
import { initProject } from '../src/tools/initProject.mjs'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { FD_ROOT, makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'


//settings.resources.* 之取值: 迴圈(domain.mjs)、評估層之資源閘(src/cli/eval.mjs)與合約之參考版(initProject.mjs)同一函數、同一鍵單一解讀(排程第 606 項; R-EV-55)
//  規格之句 ⇒ 案: 「資源上限屬執行面之設定 ⇒ K3(給了而無效 ⇒ 視為未給、改用預設; 數字字串轉為數值: K7、K4)」= 全值表(各鍵 × 有效值與無效值);
//    「同一鍵單一解讀(迴圈側與評估器共用同一讀取函數: 同一預設、同一範圍)」= 同一組設定經兩側所得之 limits 相同鍵之值相同 + 原始碼之盤點(src 內無直接讀取 resources 之鍵)+ 評估器實跑(數字字串之 evalMaxWaitSec 等被採用);
//    「evalCpuStart、evalMaxWaitSec 為計時 / 門檻依 §3.7」= 範圍(0 為不等待; 換成毫秒不超過 2147483647)
//  修前(1.0.47): 兩側各自以 typeof number 判定 ⇒ 數字字串被視為未給(資源閘不啟動、等待上限用預設)
let NODE = process.execPath
//新增之具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { resourceCfgOf, RESOURCE_NUMS, rsiNumOf, EVAL_GATE_WAIT_SEC } = RN

describe('settings.resources.* 之單一解讀(R-EV-55)', function () {
    this.timeout(300000)
    let t = makeTmp('resourceCfg')
    after(() => t.cleanup())

    describe('resourceCfgOf: 各鍵之全值表', () => {
        //各鍵之種類(獨立寫成之預期, 不取自 RESOURCE_NUMS): 有效值 [輸入, 取值]、無效值(取 null = 未給)
        let COMMON_BAD = ['abc', '', '  ', true, false, null, undefined, [], {}, NaN, Infinity, -Infinity, '0x10', '1,5', 10n, [5], () => 1]
        let TABLE = {
            cpuMax: { ok: [[70, 70], ['70', 70], [' 70 ', 70], ['7e1', 70], [0, 0], [-3, -3], [120, 120], ['-0.5', -0.5]], bad: COMMON_BAD },
            ramUsedMaxGB: { ok: [[110, 110], ['110.5', 110.5], [0.5, 0.5]], bad: COMMON_BAD },
            cpuStart: { ok: [[55, 55], ['55', 55]], bad: COMMON_BAD },
            ramStartGB: { ok: [[102, 102], ['102', 102]], bad: COMMON_BAD },
            //計時值: 正數且換成毫秒不超過 2147483647(sampleSec、pollSec)
            sampleSec: { ok: [[5, 5], ['5', 5], [0.001, 0.001], [2147483, 2147483], [2147483.647, 2147483.647]], bad: [...COMMON_BAD, 0, -1, '0', '-5', 2147483.648, 3000000, '99999999'] },
            pollSec: { ok: [[10, 10], ['10', 10], [0.5, 0.5]], bad: [...COMMON_BAD, 0, -1, '0', 2147484] },
            //最長等待: 非負數(0 = 不等待), 換成毫秒不超過 2147483647
            //邊界: 分鐘 × 60000 ≤ 2147483647 ⇒ 35791.39 通過、35791.4 不通過; 秒 × 1000 ≤ 2147483647 ⇒ 2147483.647 通過、2147483.648 不通過
            maxWaitMin: { ok: [[30, 30], ['30', 30], [0, 0], ['0', 0], [35791, 35791], [35791.39, 35791.39], [0.5, 0.5]], bad: [...COMMON_BAD, -1, '-1', 35791.4, 35792, 1e9] },
            evalCpuStart: { ok: [[60, 60], ['60', 60], [1, 1]], bad: COMMON_BAD },
            evalMaxWaitSec: { ok: [[90, 90], ['90', 90], [0, 0], [2147483, 2147483], [2147483.647, 2147483.647]], bad: [...COMMON_BAD, -1, '-1', 2147483.648, 2147484, 1e12] },
        }
        it('RESOURCE_NUMS 之鍵 = 本表之鍵(9 個); 各鍵之種類於 RSI_NUM_KINDS 有定義', () => {
            assert.deepEqual(Object.keys(RESOURCE_NUMS).sort(), Object.keys(TABLE).sort())
            assert.equal(Object.keys(TABLE).length, 9)
            for (let [k, kind] of Object.entries(RESOURCE_NUMS)) {
                assert(Object.prototype.hasOwnProperty.call(RN.RSI_NUM_KINDS, kind), `${k}: 種類 ${kind} 已定義`)
            }
        })

        for (let [key, { ok, bad }] of Object.entries(TABLE)) {
            it(`${key}: 有效值(數字、數字字串去頭尾空白)取轉換值; 無效、未給取 null(= 用預設); 其餘鍵不受影響; 不改呼叫端之物件`, () => {
                for (let [v, want] of ok) {
                    let o = { [key]: v }
                    let r = resourceCfgOf(o)
                    assert.strictEqual(r[key], want, `${key} = ${JSON.stringify(v)}`)
                    assert.strictEqual(typeof r[key], 'number', `${key}: 轉為數值(K4)`)
                    assert.deepEqual(o, { [key]: v }, '不改輸入')
                    for (let k2 of Object.keys(TABLE).filter((k) => k !== key)) {
                        assert.strictEqual(r[k2], null, `${key} 有效時 ${k2} 未給 ⇒ null`)
                    }
                }
                for (let v of bad) {
                    //NaN 與 BigInt 等以 Object.is / typeof 判; 斷言訊息不內插(BigInt 不可序列化)
                    assert.ok(resourceCfgOf({ [key]: v })[key] === null, `${key} 之無效值(第 ${bad.indexOf(v)} 個)應為 null`)
                }
            })
        }

        it('resources 本身非物件(未給、null、陣列、字串、數字)⇒ 全部未給(各鍵 null; 不拋)', () => {
            for (let rs of [undefined, null, [], 'x', 7, true, () => 1]) {
                let r = resourceCfgOf(rs)
                for (let k of Object.keys(TABLE)) {
                    assert.strictEqual(r[k], null, `${String(typeof rs)} ${k}`)
                }
                assert.strictEqual(r.loopGate.maxWaitSec, null)
                assert.strictEqual(r.evalGate.cpuStart, null)
                assert.strictEqual(r.evalGate.maxWaitSec, EVAL_GATE_WAIT_SEC)
            }
            assert.equal(EVAL_GATE_WAIT_SEC, 90)
        })
    })

    describe('loopGate 與 evalGate(兩側之選項; 同一鍵單一解讀)', () => {
        let RS = { cpuMax: ' 70 ', ramUsedMaxGB: '110', cpuStart: '55', ramStartGB: '102', sampleSec: '5', pollSec: '10', maxWaitMin: '30', evalCpuStart: '60', evalMaxWaitSec: '45' }
        let RSN = { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 55, ramStartGB: 102, sampleSec: 5, pollSec: 10, maxWaitMin: 30, evalCpuStart: 60, evalMaxWaitSec: 45 }
        it('數字字串之設定 ≡ 數字之設定(兩側之選項逐鍵相同; 修前字串被視為未給)', () => {
            assert.deepEqual(resourceCfgOf(RS).loopGate, resourceCfgOf(RSN).loopGate)
            assert.deepEqual(resourceCfgOf(RS).evalGate, resourceCfgOf(RSN).evalGate)
            assert.deepEqual(resourceCfgOf(RSN).loopGate, { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 55, ramStartGB: 102, sampleSec: 5, pollSec: 10, maxWaitSec: 1800 })
            assert.deepEqual(resourceCfgOf(RSN).evalGate, { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 60, ramStartGB: 102, maxWaitSec: 45 })
        })

        it('預設: 迴圈側 cpuStart / ramStartGB 未給 ⇒ 交資源閘之預設(cpuMax − 15、ramUsedMaxGB − 8); 評估層 cpuStart 未給 ⇒ cpuMax − 5(最低 1)、maxWaitSec 未給 ⇒ 90; 評估層之 ramStartGB 同迴圈側', () => {
            let r = resourceCfgOf({ cpuMax: 70, ramUsedMaxGB: 110 })
            assert.deepEqual(r.loopGate, { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: null, ramStartGB: null, sampleSec: null, pollSec: null, maxWaitSec: null })
            assert.deepEqual(r.evalGate, { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 65, ramStartGB: null, maxWaitSec: 90 })
            assert.equal(resourceCfgOf({ cpuMax: 3 }).evalGate.cpuStart, 1, 'cpuMax − 5 最低 1')
            assert.equal(resourceCfgOf({ ramUsedMaxGB: 50 }).evalGate.cpuStart, null, '無 cpuMax 且無 evalCpuStart ⇒ null')
            //evalCpuStart 無效 ⇒ 回到 cpuMax − 5
            assert.equal(resourceCfgOf({ cpuMax: 70, evalCpuStart: 'abc' }).evalGate.cpuStart, 65)
            //evalMaxWaitSec 無效或超出 ⇒ 90; 0 ⇒ 0(不等待)
            assert.equal(resourceCfgOf({ evalMaxWaitSec: 'abc' }).evalGate.maxWaitSec, 90)
            assert.equal(resourceCfgOf({ evalMaxWaitSec: 3000000 }).evalGate.maxWaitSec, 90)
            assert.equal(resourceCfgOf({ evalMaxWaitSec: 0 }).evalGate.maxWaitSec, 0)
            assert.equal(resourceCfgOf({ maxWaitMin: 0 }).loopGate.maxWaitSec, 0)
            assert.equal(resourceCfgOf({ maxWaitMin: '1.5' }).loopGate.maxWaitSec, 90)
        })

        it('資源閘(createResourceMonitor)收兩側之選項 ⇒ stats().limits 之各鍵相同(同一組設定): cpuMax、ramUsedMaxGB、ramStartGB 兩側同值; 數字字串之 opt 亦轉為數值(opt 同一口徑)', () => {
            let L = resourceCfgOf(RS).loopGate
            let E = resourceCfgOf(RS).evalGate
            let lm = createResourceMonitor({ ...L }).stats().limits
            let em = createResourceMonitor({ ...E, pollSec: 5, jitter: 0.6 }).stats().limits
            assert.deepEqual(lm, { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 55, ramStartGB: 102 })
            assert.deepEqual(em, { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 60, ramStartGB: 102 })
            for (let k of ['cpuMax', 'ramUsedMaxGB', 'ramStartGB']) {
                assert.strictEqual(lm[k], em[k], `${k}: 兩側同值`)
            }
            //opt 本身(數字字串)亦同一口徑; 無效 ⇒ 未給(預設)
            let dm = createResourceMonitor({ cpuMax: '80', ramUsedMaxGB: ' 20 ', cpuStart: 'abc', ramStartGB: true }).stats().limits
            assert.deepEqual(dm, { cpuMax: 80, ramUsedMaxGB: 20, cpuStart: 65, ramStartGB: 12 }, 'cpuStart 無效 ⇒ cpuMax − 15; ramStartGB 無效 ⇒ ramUsedMaxGB − 8')
        })

        it('迴圈(makeProject.monitor)之資源閘取 loopGate: settings.resources 為數字字串 ⇒ stats().limits 為數值(cpuStart 取 cpuStart 而非 evalCpuStart); 評估層之鍵(evalCpuStart、evalMaxWaitSec)不入迴圈之閘; 無效之鍵 ⇒ 該鍵用預設', () => {
            let mkP = (resources) => {
                let st = getSettings()
                let d = path.join(t.dir, `loop_${Math.random().toString(36).slice(2, 8)}`)
                st.resources = resources
                st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false }
                st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
                st.eval.ledgerDir = path.join(d, 'ledger')
                fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
                fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthRes' }), 'utf8')
                return makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
            }
            let a = mkP(RS)
            assert.deepEqual(a.monitor.stats().limits, { cpuMax: 70, ramUsedMaxGB: 110, cpuStart: 55, ramStartGB: 102 })
            let b = mkP(RSN)
            assert.deepEqual(b.monitor.stats().limits, a.monitor.stats().limits, '數字之設定同')
            //評估層之鍵不入迴圈之閘; 迴圈之 cpuStart 未給 ⇒ cpuMax − 15(非 evalCpuStart 或 cpuMax − 5)
            let c = mkP({ cpuMax: 80, ramUsedMaxGB: 100, evalCpuStart: 10, evalMaxWaitSec: 1 })
            assert.deepEqual(c.monitor.stats().limits, { cpuMax: 80, ramUsedMaxGB: 100, cpuStart: 65, ramStartGB: 92 })
            //無效之鍵 ⇒ 未給(cpuMax 無效 ⇒ 無上限、cpuStart 無預設): 其餘之鍵照用
            let d = mkP({ cpuMax: 'abc', ramUsedMaxGB: '100', cpuStart: true })
            assert.deepEqual(d.monitor.stats().limits, { cpuMax: null, ramUsedMaxGB: 100, cpuStart: null, ramStartGB: 92 })
        })

        it('資源閘之等待上限與間隔取同一口徑: maxWaitSec 數字字串 ⇒ 轉數值(0 = 立即放行並記 forced); sampleSec、pollSec 無效 ⇒ 預設(取樣於 start 事件可觀察)', async () => {
            let events = []
            let rows = [{ cpu: 95, ram: 120 }]
            let read = () => ({ cpuTimes: { idle: 0, total: 1 }, ramUsedGB: rows[0].ram })
            let m = createResourceMonitor({ cpuMax: '70', ramUsedMaxGB: '110', maxWaitSec: '0', read, sleep: async () => {}, onTrace: (e) => events.push(e) })
            let w = await m.wait('x')
            assert.strictEqual(w.forced, true, 'maxWaitSec "0" ⇒ 不等待、逾時放行')
            let ev2 = []
            let m2 = createResourceMonitor({ sampleSec: 'abc', pollSec: -1, read, onTrace: (e) => ev2.push(e) })
            m2.start()
            m2.stop()
            assert.strictEqual(ev2.find((e) => e.type === 'start').sampleSec, 5, 'sampleSec 無效 ⇒ 5')
            let ev3 = []
            let m3 = createResourceMonitor({ sampleSec: '2', read, onTrace: (e) => ev3.push(e) })
            m3.start()
            m3.stop()
            assert.strictEqual(ev3.find((e) => e.type === 'start').sampleSec, 2, '數字字串 ⇒ 轉數值')
        })
    })

    describe('原始碼之盤點(同一鍵單一解讀)', () => {
        //直接讀取 resources 之鍵之樣式(別名: st.resources、rs、rc、r、o、opt 之 .鍵); rsiNums.mjs 本身(取值函數所在)與 resources.mjs(以 rsiNumOf 讀自己之 opt)除外
        let KEYS = ['cpuMax', 'ramUsedMaxGB', 'cpuStart', 'ramStartGB', 'sampleSec', 'pollSec', 'maxWaitMin', 'evalCpuStart', 'evalMaxWaitSec'] //獨立寫成(與 TABLE 之鍵相同; 另有案核對 RESOURCE_NUMS 之鍵 = TABLE 之鍵)
        let scan = (rel, text) => {
            let out = []
            text.split(/\r?\n/).forEach((line, li) => {
                if (/^\s*(\/\/|\*|\/\*)/.test(line)) {
                    return
                }
                let code = line.replace(/\s\/\/.*$/, '')
                for (let k of KEYS) {
                    if (new RegExp(`\\b(?:st\\.resources|resources|rs|rc)\\.${k}\\b(?!\\s*[:=](?!=))`).test(code)) {
                        out.push(`${rel}:${li + 1}: ${code.trim().slice(0, 120)}`)
                    }
                }
            })
            return out
        }
        it('src 內(不含註解行、rsiNums.mjs 與 resources.mjs 本身)不直接讀取 settings.resources 之鍵之原值(一律經 resourceCfgOf); 範圍含 src/cli/eval.mjs 與 src/tools/initProject.mjs', () => {
            let walk = (dir, out = []) => {
                for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
                    let fp = path.join(dir, f.name)
                    if (f.isDirectory()) {
                        walk(fp, out)
                    }
                    else if (f.name.endsWith('.mjs')) {
                        out.push(fp)
                    }
                }
                return out
            }
            let files = walk(path.join(FD_ROOT, 'src'))
            assert(files.some((f) => f.endsWith(path.join('cli', 'eval.mjs'))) && files.some((f) => f.endsWith(path.join('tools', 'initProject.mjs'))), '掃描範圍含評估器之進入檔與 initProject')
            let bad = []
            let nLine = 0
            for (let fp of files.filter((f) => !f.endsWith('rsiNums.mjs') && !f.endsWith(`${path.sep}resources.mjs`))) {
                let rel = path.relative(FD_ROOT, fp).replace(/\\/g, '/')
                let text = fs.readFileSync(fp, 'utf8')
                nLine += text.split(/\r?\n/).length
                bad.push(...scan(rel, text))
            }
            assert(nLine > 15000, `掃描之行數 ${nLine}`)
            assert.deepEqual(bad, [])
            //讀取處皆經 resourceCfgOf: 迴圈、評估器之進入檔、initProject、g_rsi 之日誌各一
            for (let rel of ['src/domain/domain.mjs', 'src/cli/eval.mjs', 'src/tools/initProject.mjs', 'src/cli/rsi.mjs']) {
                assert(/\bresourceCfgOf\(/.test(fs.readFileSync(path.join(FD_ROOT, rel), 'utf8')), `${rel}: 經 resourceCfgOf`)
            }
        })

        it('鑑別前提: 盤點樣式抓得到修前之寫法(評估器之 `rs.cpuMax`、迴圈之 `rc.cpuMax`、`typeof rc.maxWaitMin`、`rs.evalMaxWaitSec`)與 `st.resources.sampleSec`; 不誤抓物件字面量與賦值', () => {
            let old = 'let rs = st.resources\nif (num(rs.cpuMax) !== null) {\n    cpuStart: num(rs.evalCpuStart) !== null ? rs.evalCpuStart : 1,\n}\nlet m = createResourceMonitor({ cpuMax: rc.cpuMax, maxWaitSec: typeof rc.maxWaitMin === \'number\' ? rc.maxWaitMin * 60 : undefined })\nlet w = numOnly(rs.evalMaxWaitSec, 90)\nlet s = st.resources && st.resources.sampleSec ? 1 : 5\n'
            let hits = scan('old', old)
            assert(hits.length >= 6, `抓到 ${hits.length}`)
            assert.deepEqual(scan('new', 'let o = { cpuMax: 70 }\nrs.cpuMax = 3\n// rs.cpuMax\nlet a = resourceCfgOf(st.resources)\n'), [])
        })
    })

    describe('合約之參考版(initProject)與評估器之實跑: 數字字串之設定被採用(同一鍵單一解讀)', () => {
        it('initProject: resources.evalMaxWaitSec 為數字字串 ⇒ 合約之「至多約 N 秒」寫入轉換值(同評估層之資源閘); 無效 ⇒ 90(參考版之值)', () => {
            let mk = (name, rs) => {
                let dir = path.join(t.dir, name)
                fs.mkdirSync(dir, { recursive: true })
                let s = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
                s.resources = {} //資源閘預設關閉(同 unit-testResources 之守則); 本案之 evalMaxWaitSec 等再疊上
                Object.assign(s.resources, rs)
                fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s), 'utf8')
                initProject({ root: dir })
                return fs.readFileSync(path.join(dir, 'docs', 'pick-contract.md'), 'utf8')
            }
            assert(mk('c120', { evalMaxWaitSec: '120' }).includes('至多約 120 秒'))
            assert(mk('c45', { evalMaxWaitSec: 45 }).includes('至多約 45 秒'))
            assert(mk('cbad', { evalMaxWaitSec: 'abc' }).includes('至多約 90 秒'))
            assert(mk('cneg', { evalMaxWaitSec: -5 }).includes('至多約 90 秒'), '負數 ⇒ 無效 ⇒ 90')
            assert(mk('cnone', {}).includes('至多約 90 秒'))
        })

        it('g_eval 實跑: resources 之 cpuMax / ramUsedMaxGB / ramStartGB / evalMaxWaitSec 為數字字串 ⇒ 資源閘啟動並於 evalMaxWaitSec 後照常開始(印「資源閘: …」); 無此設定者不等待(修前: 字串被視為未給 ⇒ 閘不啟動)', function () {
            this.timeout(240000)
            let root = path.join(t.dir, 'ev')
            let W = path.join(root, 'rsi', 'work', 'w1')
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            fs.mkdirSync(W, { recursive: true })
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 40, nBars: 2400, seed: 5 })
            let mkSettings = (resources) => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: { workDir: './rsi/work' },
                dispatch: {},
                resources,
            }), 'utf8')
            fs.writeFileSync(path.join(W, 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) {\n        if (ctx.rand() < 0.3) ids.push(s)\n    }\n    return ids\n}\n', 'utf8')
            let run = () => {
                let e = { ...process.env, ARSI_ROOT: root }
                delete e.ARSI_HARNESS
                let t0 = Date.now()
                let r = spawnSync(NODE, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', path.join(W, 'pick.mjs'), '--mode', 'quick', '--no-log'], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
                return { status: r.status, out: `${r.stdout}`, sec: (Date.now() - t0) / 1000 }
            }
            //門檻不可能達成(已用記憶體 0.001 GB 以下)⇒ 等到 evalMaxWaitSec 後「已達最長等待, 照常開始」; 上限 1000 GB(取樣不計超限)
            mkSettings({ cpuMax: '99', ramUsedMaxGB: '1000', ramStartGB: '0.001', evalMaxWaitSec: '3' })
            let a = run()
            assert.strictEqual(a.status, 0, a.out.slice(0, 400))
            assert(/資源閘: 全機負載偏高, 等待 \d+ 秒後開始評估\(已達最長等待, 照常開始\)/.test(a.out), `數字字串之資源上限被採用: ${a.out.slice(0, 500)}`)
            //同一組設定以數字寫 ⇒ 同樣之行為(兩種寫法等價)
            mkSettings({ cpuMax: 99, ramUsedMaxGB: 1000, ramStartGB: 0.001, evalMaxWaitSec: 3 })
            let b = run()
            assert(/資源閘: 全機負載偏高, 等待 \d+ 秒後開始評估\(已達最長等待, 照常開始\)/.test(b.out), b.out.slice(0, 500))
            //無效之字串 ⇒ 視為未給(閘不啟動 ⇒ 不等待、不印)
            mkSettings({ cpuMax: 'abc', ramUsedMaxGB: 'x', ramStartGB: '0.001', evalMaxWaitSec: '3' })
            let c = run()
            assert.strictEqual(c.status, 0)
            assert(!c.out.includes('資源閘'), `無有效之上限 ⇒ 閘不啟動: ${c.out.slice(0, 300)}`)
            //鑑別前提: rsiNumOf 本身之種類(waitSec 之 0 為有效)
            assert.strictEqual(rsiNumOf('0', 'waitSec'), 0)
        })
    })
})
