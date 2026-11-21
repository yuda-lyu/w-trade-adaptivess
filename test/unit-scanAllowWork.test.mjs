import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { dirWorkIdsOf, dirNodeIdsOf, allowWorkOf } from '../src/domain/verify.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'


//操作掃描之「可讀之他節點工作夾」(allowWork; 規則 R-BT-9、R-REC-13): 迴圈驗證、--mode validate 之重掃(rescanTraces)與 tools/scanCheck.mjs 共用同一求法
//  規格(R-BT-9): ①可讀 = 起點(spec.base)、任務書列為參考之節點(task.refs)、來源方向(主張、依據、預期)內指名之節點(完整 id 或前 8 碼以上之十六進位字串且於已執行之節點中唯一對應者)、
//    來源方向(依據、預期)內提到之工作夾(<工作夾之根>/<id>)②scanCheck(唯讀之對照)與寫回(rescanTraces)對同一節點之同一份操作紀錄得同一組「存取其他節點之工作夾」項 ⇒ 方向內只以 id 指名(未寫路徑)者不得只被 scanCheck 列為觸犯
//  合成資料: 節點 id 由規格雜湊而得(逐節點相異); 十六進位之 id 前綴取自其 id
let seq = 0
let T0 = Date.parse('2026-03-02T00:00:00Z')
let at = () => new Date(T0 + ++seq * 1000).toISOString()
let API = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

describe('可讀之他節點工作夾(規則 R-BT-9):迴圈驗證、重掃與 scanCheck 共用同一求法', function () {
    this.timeout(120000)

    describe('純函數', function () {
        //十六進位之 id: 逐筆相異, 其中 H1 與 H2 之前 8 碼相同(前綴對應不唯一之案)
        let H1 = 'a1b2c3d4e5f60718'
        let H2 = 'a1b2c3d4ffee9900'
        let H3 = '0f1e2d3c4b5a6978'
        let H4 = '9e8d7c6b5a493827'
        let IDS = [H1, H2, H3, H4]

        it('dirNodeIdsOf:指名之節點 = 主張、依據、預期內之十六進位字串(8 ~ 16 碼)且於 ids 中唯一對應;前綴對應不唯一、少於 8 碼、非十六進位、不在 ids 者不算;同一節點只列一次', () => {
            //規格 R-BT-9 ①: 完整 id 或前 8 碼以上、唯一對應者
            assert.deepEqual(dirNodeIdsOf({ claim: `以 ${H3.slice(0, 8)} 為底`, rationale: '', expect: '' }, IDS), [H3])
            assert.deepEqual(dirNodeIdsOf({ claim: '', rationale: `對照 ${H4}`, expect: '' }, IDS), [H4], '完整 id(16 碼)')
            assert.deepEqual(dirNodeIdsOf({ claim: '', rationale: '', expect: `${H3.slice(0, 10)} 優於 ${H4.slice(0, 9)}` }, IDS), [H3, H4], '預期欄;依出現之次序')
            assert.deepEqual(dirNodeIdsOf({ claim: H3.slice(0, 8), rationale: H3.slice(0, 12), expect: H3 }, IDS), [H3], '同一節點只列一次')
            //前綴對應 H1 與 H2 兩個 ⇒ 不唯一 ⇒ 不算
            assert.deepEqual(dirNodeIdsOf({ claim: H1.slice(0, 8), rationale: '', expect: '' }, IDS), [])
            assert.deepEqual(dirNodeIdsOf({ claim: H1.slice(0, 9), rationale: '', expect: '' }, IDS), [H1], '再多一碼即唯一')
            assert.deepEqual(dirNodeIdsOf({ claim: H3.slice(0, 7), rationale: '', expect: '' }, IDS), [], '少於 8 碼')
            assert.deepEqual(dirNodeIdsOf({ claim: 'zzzzzzzzzz 0f1e2d3x', rationale: '', expect: '' }, IDS), [], '非十六進位')
            assert.deepEqual(dirNodeIdsOf({ claim: '12345678 abcdef12', rationale: '', expect: '' }, IDS), [], '不在 ids 者')
            assert.deepEqual(dirNodeIdsOf({ claim: H3 }, IDS), [H3], '其他欄缺')
            assert.deepEqual(dirNodeIdsOf(null, IDS), [])
            assert.deepEqual(dirNodeIdsOf({ claim: H3 }, undefined), [])
        })

        it('dirWorkIdsOf:方向之依據與預期內提到之工作夾(<根>/<id>);主張內者不算;根之字元當字面;同一 id 只列一次', () => {
            let w = 'rsi/work'
            assert.deepEqual(dirWorkIdsOf({ claim: 'rsi/work/c_only', rationale: '見 rsi/work/dream_r001/x.mjs', expect: '與 rsi/work/dream_r002 及 rsi/work/dream_r001' }, w), ['dream_r001', 'dream_r002'])
            assert.deepEqual(dirWorkIdsOf({ claim: '', rationale: 'rsiXwork/dream_r003', expect: '' }, w), [], '根之「/」「.」不當萬用字元')
            assert.deepEqual(dirWorkIdsOf({ claim: '', rationale: 'a.b/w/id9 axb/w/id8', expect: '' }, 'a.b/w'), ['id9'], '「.」為字面')
            assert.deepEqual(dirWorkIdsOf(null, w), [])
            assert.deepEqual(dirWorkIdsOf({ rationale: 'rsi/work/x' }, w), ['x'], '預期欄缺')
        })

        it('allowWorkOf:起點、任務書列為參考之節點(只取有 nodeId 者)、方向內之工作夾、方向內指名之節點;依此次序', () => {
            let d = {
                spec: { base: 'base_node_id' },
                task: { refs: [{ nodeId: 'ref_node_1' }, { file: 'x.md' }, { nodeId: 'ref_node_2' }], direction: { claim: `以 ${H3.slice(0, 8)} 為底`, rationale: '見 rsi/work/dream_r001', expect: '' } },
            }
            assert.deepEqual(allowWorkOf(d, { workRel: 'rsi/work', ids: IDS }), ['base_node_id', 'ref_node_1', 'ref_node_2', 'dream_r001', H3])
            assert.deepEqual(allowWorkOf({ spec: { base: null }, task: { refs: [], direction: null } }, { workRel: 'rsi/work', ids: IDS }), [])
            assert.deepEqual(allowWorkOf({}, { workRel: 'rsi/work', ids: IDS }), [])
        })
    })

    describe('scanCheck 與重掃(真之樹)', function () {
        let t
        beforeEach(() => {
            t = makeTmp('scanAllowWork')
        })
        afterEach(() => {
            t.cleanup()
        })
        //節點: A = 讀取者(方向以 id 前 8 碼指名 B、以路徑指名 dream_r001; 其操作紀錄讀 B、C 與 dream_r001 之檔)、B = 被指名者、C = 未被指名者
        let mk = () => {
            let st = getSettings()
            let d = path.join(t.dir, 'proj')
            st.resources = {}
            st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), autoFill: false, docLimits: false }
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthAllow' }), 'utf8')
            let P = makeProject(st, { gate: null, catalogFile: path.join(d, 'catalog.json') })
            P.rsi.init()
            let ARMS = { A: ['A01_nt'], B: ['A02_ntPit'], C: ['A04_act'] }
            let SC = { A: 11.1, B: 22.2, C: 33.3 }
            let ids = {}
            let specOf = (k) => ({ arms: ARMS[k].slice().sort(), base: null })
            for (let k of Object.keys(ARMS)) {
                ids[k] = P.idOf(specOf(k))
            }
            let wr = st.records.workDir.replace(/\\/g, '/')
            for (let [i, k] of Object.keys(ARMS).entries()) {
                let id = ids[k]
                let spec = specOf(k)
                let metrics = { selHash: `sel-${k}`, op: { eqYr: { mean: 10 + i * 1.3, min: -2 - i * 0.4, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + i) }, monthlyOrders: { mean: 80 + i }, peakHold: { max: 20 + i } }, null: { mean: -3 - i, excess: 5 + i, z: 1 + i / 10, p: 0.002 * (i + 1) } }
                let direction = k === 'A' ? { claim: `以 ${ids.B.slice(0, 8)} 之成品為底`, rationale: `診斷見 ${path.relative(FD_ROOT, st.records.workDir).replace(/\\/g, '/')}/dream_r001/notes.md`, expect: '較其高', arms: [], base: null } : null
                P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [], selHash: `sel-${k}` }, score: { S: SC[k], ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust: null } })
                P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', createdAt: at(), spec, task: { goal: '合成', type: 'explore', claim: null, arms: [], base: null, refs: [], direction }, agent: { role: 'node', kind: 'fake', model: 'fake-node', startedAt: at(), endedAt: at(), durationSec: 600 + i, ok: true, error: null }, plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'pick.mjs', files: [], reused: [] }, results: { claimed: { S: SC[k] }, experiments: [] }, conclusion: { outcome: 'neutral', summary: 's', findings: [], limitations: [], nextIdeas: [] }, harness: { ok: true, summary: [], notes: [], score: { S: SC[k], ladder: 1, flags: { vetoed: false, why: [] } }, fingerprint: `sel-${k}`, checks: { issues: [], nEvals: 1 }, validation: null, raw: { metrics }, evalJson: null, error: null }, audit: null, history: [] })
                fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
            }
            //A 之操作紀錄: 讀 B 之 pick.mjs(方向以 id 前 8 碼指名 ⇒ 可讀)、C 之 pick.mjs(未指名 ⇒ 不可讀)、dream_r001 之 notes.md(方向以路徑指名 ⇒ 可讀)
            fs.writeFileSync(path.join(st.records.workDir, ids.A, 'agent_a1.log'), [`${wr}/${ids.B}/pick.mjs`, `${wr}/${ids.C}/pick.mjs`, `${wr}/dream_r001/notes.md`].map((fp) => API('Read', { file_path: fp })).join('\n') + '\n', 'utf8')
            return { P, st, d, ids }
        }
        let accessOf = (issues) => (issues || []).filter((s) => /^存取其他節點之工作夾/.test(s))

        it('方向內只以 id 前 8 碼指名之節點:重掃與 scanCheck 同列「存取其他節點之工作夾」之同一組(只列未指名之 C);重掃後 scanCheck 為「相同」', () => {
            let x = mk()
            let id8 = (k) => x.ids[k].slice(0, 8)
            //子行程之專案根 = 合成專案(同 unit-evalHints 之 scanCheck 案)
            let stJ = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            stJ.eval = { ...stJ.eval, ledgerDir: './ledger' }
            stJ.resources = {}
            fs.writeFileSync(path.join(x.d, 'settings.json'), JSON.stringify(stJ, null, 1), 'utf8')
            let run = () => spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'scanCheck.mjs')], { cwd: x.d, env: { ...process.env, ARSI_ROOT: x.d }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
            let lineOf = (r, k) => r.stdout.split('\n').find((l) => l.startsWith(`${id8(k)} r1 `))
            //寫回(重掃): 只列 C
            assert.equal(x.P.rescanTraces() >= 1, true)
            let issues = accessOf(x.P.records.getNodeDoc(x.ids.A).harness.checks.issues)
            assert.equal(issues.length, 1, JSON.stringify(issues))
            assert(issues[0].startsWith(`存取其他節點之工作夾(${x.ids.C.slice(0, 12)})`), issues[0])
            assert.deepEqual(accessOf(x.P.rsi.store.getNode(x.ids.A).raw.issues), issues, '樹與節點文件同一份')
            //唯讀之對照: 與寫回同一組 ⇒ 「相同」(修前: scanCheck 另把 B 列為觸犯 ⇒ 「不同」)
            let r = run()
            assert.equal(r.status, 0, r.stderr)
            assert(lineOf(r, 'A').startsWith(`${id8('A')} r1 相同 | 現行規則 1 項`), lineOf(r, 'A'))
            assert(/與節點文件不同者 0 份/.test(r.stdout), r.stdout)
            //B、C 之紀錄無操作紀錄 ⇒ 相同、0 項
            assert(lineOf(r, 'B').startsWith(`${id8('B')} r1 相同 | 現行規則 0 項`), lineOf(r, 'B'))
        })

        it('寫回前之對照: 節點文件尚無此項時 scanCheck 列「不同」與現行規則之一項(C);其項即寫回所得之項(逐字相同)', () => {
            let x = mk()
            let stJ = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            stJ.eval = { ...stJ.eval, ledgerDir: './ledger' }
            stJ.resources = {}
            fs.writeFileSync(path.join(x.d, 'settings.json'), JSON.stringify(stJ, null, 1), 'utf8')
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'scanCheck.mjs'), x.ids.A.slice(0, 8)], { cwd: x.d, env: { ...process.env, ARSI_ROOT: x.d }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
            assert.equal(r.status, 0, r.stderr)
            let line = r.stdout.split('\n').find((l) => l.startsWith(`${x.ids.A.slice(0, 8)} r1 `))
            assert(line.startsWith(`${x.ids.A.slice(0, 8)} r1 **不同** | 現行規則 1 項: 存取其他節點之工作夾(${x.ids.C.slice(0, 12)})`), line)
            assert(!line.includes(`存取其他節點之工作夾(${x.ids.B.slice(0, 12)})`), '被指名之 B 不列')
        })

        it('任務書(taskFor)之參考:來源方向以 id 前 8 碼指名之節點列入參考(領域之 dirNodeIds 經共用之 dirNodeIdsOf);前綴對應不唯一者不列', () => {
            let x = mk()
            let specA = { arms: ['A01_nt'], base: null }
            let dream = (rationale) => x.P.records.putDreamDoc({
                round: 2,
                createdAt: '2026-11-15T00:00:00.000Z',
                agent: { model: 'm', durationSec: 1 },
                scope: { nodes: [] },
                audits: [],
                synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
                guidance: { directions: [{ type: 'explore', arms: specA.arms, base: null, rationale, expect: 'e2' }], avoid: [], openQuestions: [], improvements: [] },
                docsUpdated: [],
                harness: { applied: { accepted: [], rework: [], deleted: [], proposals: [], skipped: [] } },
            })
            //B 為「不可信」⇒ 不入「目前回測期 S 較高之節點」之清單; 其入參考只能因來源方向指名
            x.P.rsi.store.updateNode(x.ids.B, (n) => {
                n.evidence = { trust: 'untrusted' }
            })
            let named = () => x.P.taskFor(specA, 3).refs.filter((r) => r.nodeId && r.why.includes('來源方向指名之節點')).map((r) => r.nodeId)
            dream(`以 ${x.ids.B.slice(0, 8)} 之成品為底`)
            assert.deepEqual(named(), [x.ids.B], '指名之 B 列入參考')
            //前 7 碼(不足 8 碼)不算指名 ⇒ 不列(同一份方向文件換寫)
            dream(`以 ${x.ids.B.slice(0, 7)} 之成品為底`)
            assert.deepEqual(named(), [], '前 7 碼不足')
        })

        it('結構: 三處(領域之 dirWorkIds / dirNodeIds 與 rescanTraces、scanCheck)不各自再算一份(只經 verify.mjs 之三函數)', () => {
            let read = (...p) => fs.readFileSync(path.join(FD_ROOT, ...p), 'utf8')
            let dom = read('src', 'domain', 'domain.mjs')
            let sc = read('src', 'tools', 'scanCheck.mjs')
            assert(/allowWorkOf\(d, \{ workRel, ids \}\)/.test(dom), 'rescanTraces 經 allowWorkOf')
            assert(/let dirWorkIds = \(direction\) => dirWorkIdsOf\(direction, workRelOf\(\)\)/.test(dom), '迴圈驗證之 refsOf 用之 dirWorkIds 經 dirWorkIdsOf')
            assert(/dirNodeIdsOf\(direction, executedIds\(\)\)/.test(dom), '迴圈驗證之 refsOf 與任務書用之 dirNodeIds 經 dirNodeIdsOf')
            assert(!/matchAll\(\/\\b\[0-9a-f\]\{8,16\}\\b\/g\)/.test(dom), '領域不另寫指名之節點之判定')
            assert(/allowWorkOf\(d, /.test(sc), 'scanCheck 經 allowWorkOf')
            assert(!/matchAll\(/.test(sc), 'scanCheck 不另寫方向內提到之工作夾之判定')
        })
    })
})
