import assert from 'assert'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { renderDreamMd } from '../src/arsi/records.mjs'
import { planGateOf, roundOkOf, trailingFailures } from '../src/arsi/runner.mjs'
import { peekRound, specHash } from '../src/engineApi.mjs'
import { FD_ROOT, makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'


//主控要求之「只做夢」輪次與「前緣為空時不起空輪」(Gitea #163; 規則 R-RUN-9)
//  spec: ①一般輪次於「計畫 0 個節點、無閘門拒絕、無待重審之節點」時不起(事件 run-done、rounds 0、reason 'frontier-empty'; 不耗輪號、不記為失敗輪)
//        ②主控以 --dream-only --file <文字檔> 要求時, 計畫 0 個節點之輪次仍派做夢(審計 0; 要求之原文列於任務書之最前與做夢文件);
//          計畫有節點或有待重審之節點時不受理(reason 'dream-only-busy'); 未要求者, 0 個節點之輪次照舊略過做夢
//        ③只做夢輪次之成敗 = 做夢已交付且輪末回調未失敗(不以節點數判)
//        ④錯誤訊息依跨套件規格〈輸入參數之檢測機制〉§6 V19、V20(invalid <名稱>: must be <種類>; 不帶輸入值)
//        ⑤一頁摘要之改進項取 what(做夢文件之欄位), 舊欄 change / spec 為後備
describe('只做夢輪次與前緣為空(R-RUN-9)', function () {

    describe('planGateOf / roundOkOf(純函數)', function () {
        it('一般輪次:計畫 0 個節點、無閘門拒絕、無待重審 ⇒ 不起(frontier-empty);三者任一非 0 ⇒ 起', () => {
            let g = planGateOf({ nItems: 0, nRejected: 0, nReaudit: 0 })
            assert.deepEqual([g.go, g.reason], [false, 'frontier-empty'])
            assert(/前緣為空/.test(g.detail))
            assert.deepEqual(planGateOf({ nItems: 1 }), { go: true })
            assert.deepEqual(planGateOf({ nItems: 0, nRejected: 2 }), { go: true }, '有閘門拒絕 ⇒ 該輪會結案前緣之提案, 照起')
            assert.deepEqual(planGateOf({ nItems: 0, nReaudit: 1 }), { go: true }, '有待重審之節點 ⇒ 輪末鉤子有可審計者, 照起')
            assert.deepEqual([planGateOf().go, planGateOf().reason], [false, 'frontier-empty'], '未給 = 皆為 0')
        })

        it('只做夢輪次:計畫 0 個節點且無待重審 ⇒ 起(有閘門拒絕亦起);計畫有節點或有待重審 ⇒ 不受理(dream-only-busy)', () => {
            assert.deepEqual(planGateOf({ dreamOnly: true, nItems: 0 }), { go: true })
            assert.deepEqual(planGateOf({ dreamOnly: true, nItems: 0, nRejected: 3 }), { go: true })
            let a = planGateOf({ dreamOnly: true, nItems: 2 })
            assert.deepEqual([a.go, a.reason], [false, 'dream-only-busy'])
            assert(/計畫有 2 個節點/.test(a.detail) && /起一般輪次即可/.test(a.detail), a.detail)
            let b = planGateOf({ dreamOnly: true, nItems: 0, nReaudit: 1 })
            assert.deepEqual([b.go, b.reason], [false, 'dream-only-busy'])
            assert(/待重審之節點 1 個/.test(b.detail), b.detail)
        })

        it('非正整數之數目視為 0(不因壞值而誤起或誤擋);dreamOnly 須嚴格為 true', () => {
            assert.equal(planGateOf({ nItems: -1, nRejected: NaN, nReaudit: '3' }).reason, 'frontier-empty')
            assert.deepEqual(planGateOf({ dreamOnly: true, nItems: null, nReaudit: undefined }), { go: true })
            assert.equal(planGateOf({ dreamOnly: 1, nItems: 1 }).go, true, 'dreamOnly 非 true 者當一般輪次(有節點 ⇒ 起)')
            assert.equal(planGateOf({ dreamOnly: 'true', nItems: 0 }).reason, 'frontier-empty')
        })

        it('認領中之節點(planned / running;乾跑之計畫視為已占用而正式之探索先回收遺留者):一般輪次照起(不得因乾跑為空而永不回收);只做夢輪次不受理', () => {
            assert.deepEqual(planGateOf({ nItems: 0, nRejected: 0, nReaudit: 0, nClaimed: 1 }), { go: true })
            let b = planGateOf({ dreamOnly: true, nItems: 0, nClaimed: 2 })
            assert.deepEqual([b.go, b.reason], [false, 'dream-only-busy'])
            assert(/認領中之節點 2 個/.test(b.detail), b.detail)
            assert.equal(planGateOf({ nClaimed: 0 }).reason, 'frontier-empty')
            assert.equal(planGateOf({ nClaimed: '2' }).reason, 'frontier-empty', '非整數視為 0')
        })

        it('各條件並存:一般輪次任一非 0 即起;只做夢輪次之說明同列各數目', () => {
            assert.deepEqual(planGateOf({ nItems: 1, nReaudit: 1 }), { go: true })
            assert.deepEqual(planGateOf({ nItems: 1, nRejected: 1, nReaudit: 1, nClaimed: 1 }), { go: true })
            let a = planGateOf({ dreamOnly: true, nItems: 2, nReaudit: 1, nClaimed: 3 })
            assert.deepEqual([a.go, a.reason], [false, 'dream-only-busy'])
            assert(/有 2 個節點、待重審之節點 1 個、認領中之節點 3 個/.test(a.detail), a.detail)
        })

        it('opt 非物件者視為 {}(K3;不拋 TypeError):planGateOf(null) 為前緣為空、roundOkOf(null) 為 false', () => {
            for (let bad of [null, 'x', 5, true]) {
                assert.equal(planGateOf(bad).reason, 'frontier-empty', String(bad))
                assert.equal(roundOkOf(bad), false, String(bad))
            }
        })

        it('roundOkOf:一般輪次 = 有節點執行成功且輪末回調未失敗(原判定);只做夢輪次 = 做夢已交付且輪末回調未失敗', () => {
            assert.equal(roundOkOf({ nExecuted: 3, hookFailed: false }), true)
            assert.equal(roundOkOf({ nExecuted: 0, hookFailed: false }), false)
            assert.equal(roundOkOf({ nExecuted: 3, hookFailed: true }), false)
            assert.equal(roundOkOf({ nExecuted: 0, hookFailed: false, delivered: true }), false, '一般輪次不看做夢是否交付')
            assert.equal(roundOkOf({ dreamOnly: true, nExecuted: 0, hookFailed: false, delivered: true }), true)
            assert.equal(roundOkOf({ dreamOnly: true, nExecuted: 0, hookFailed: false, delivered: false }), false, '做夢未交付 ⇒ 失敗')
            assert.equal(roundOkOf({ dreamOnly: true, nExecuted: 0, hookFailed: true, delivered: true }), false, '輪末回調失敗 ⇒ 失敗')
            assert.equal(roundOkOf({ dreamOnly: true, nExecuted: 5, hookFailed: false, delivered: false }), false, '只做夢輪次不以節點數判')
            assert.equal(roundOkOf(), false)
        })

        it('roundOkOf 之邊界:一個節點成功即算成功;未給 delivered 者不算已交付;dreamOnly 非 true 者當一般輪次;節點數非整數者不算', () => {
            assert.equal(roundOkOf({ nExecuted: 1 }), true, '一個節點成功 ⇒ 成功')
            assert.equal(roundOkOf({ dreamOnly: true, nExecuted: 0 }), false, '未給 delivered ⇒ 未交付')
            assert.equal(roundOkOf({ dreamOnly: true, hookFailed: false }), false)
            assert.equal(roundOkOf({ dreamOnly: 'yes', nExecuted: 3 }), true, 'dreamOnly 須嚴格為 true;其餘當一般輪次(有節點成功 ⇒ 成功)')
            assert.equal(roundOkOf({ dreamOnly: 1, nExecuted: 0, delivered: true }), false, 'dreamOnly 為 1 者當一般輪次(無節點 ⇒ 失敗)')
            assert.equal(roundOkOf({ nExecuted: '3' }), false, '節點數須為整數')
            assert.equal(roundOkOf({ nExecuted: 0.5 }), false)
            assert.equal(roundOkOf({ nExecuted: NaN }), false)
        })

        it('只做夢輪次之成功事件會中止事件檔末尾之連續失敗計數(與一般成功輪相同);run-done(前緣為空)不計也不打斷', () => {
            let ok = roundOkOf({ dreamOnly: true, delivered: true })
            assert.equal(trailingFailures([{ event: 'round-done', ok: false }, { event: 'round-done', ok, dreamOnly: true }]), 0)
            assert.equal(trailingFailures([{ event: 'round-done', ok: false }, { event: 'run-done', rounds: 0, reason: 'frontier-empty' }]), 1, 'run-done(前緣為空)不計也不打斷')
        })
    })

    describe('做夢任務書與做夢文件之文字', function () {
        let st0 = getSettings()
        let st = { ...st0, rsi: { ...st0.rsi, guides: false } }
        let texts = makeTexts({ st, FD_ROOT: st.FD_ROOT })
        let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
        let node = { nodeId: 'n1', arms: ['A04_act'], base: null, S: -12.3, worst: -30.1, excess: 8.2, ladder: 0, vetoed: false, claimedS: -12.3, nEvals: 6, nFull: 4, nFullSel: 4, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }
        let ctx = (nodes, extra = {}) => ({ round: 9, nodeIds: nodes.map((n) => n.nodeId), reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r009'), context: { nodes, failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox, ...extra } })
        let WHY = '評估器新增成員重抽之重放\n請以之重審現有各變體'

        it('只做夢輪次:任務書於審計範圍之前列「主控之要求(本輪為只做夢輪次)」、說明審計為空而其餘照常、要求之原文逐行引用;交付段寫 audits 為空陣列', () => {
            let d = texts.dreamBrief(ctx([], { request: { why: WHY, dreamOnly: true } }))
            assert(d.includes('## 0. 主控之要求(本輪為「只做夢」輪次)'))
            assert(d.indexOf('## 0. 主控之要求') < d.indexOf('## 1. 本輪審計範圍'), '列於審計範圍之前')
            assert(d.includes('**本輪沒有可審計之節點**') && d.includes('`audits` 給空陣列') && d.includes('整棵樹與前次做夢文件'))
            assert(d.includes('擴建(§4)'), '有共用工具區時列擴建')
            assert(d.includes('> 評估器新增成員重抽之重放\n> 請以之重審現有各變體'), '原文逐行引用')
            assert(d.includes('本輪無可審計之節點。'))
            assert(d.includes('本輪無節點,`audits` 為空陣列') && !d.includes('`audits` 已預填本輪各節點之 id'))
            assert.deepEqual(texts.dreamTemplate(ctx([], { request: { why: WHY, dreamOnly: true } })).audits, [])
            assert(d.includes('主控之要求(原文):') && d.includes('未執行者 `not-run`') && d.includes('並在 `synthesis.overview.adjust` 寫明理由,不必湊數(本輪此例外優先於 §3 對「向外之方向」之要求)。'), '說明之各句(空方向之例外明言優先於 §3)')
        })

        it('要求之原文逐行引用前去前後空白(不留空引用行);要求不為物件或其 why 非字串者視同未帶(不拋錯)', () => {
            let d = texts.dreamBrief(ctx([], { request: { why: '\n\n  甲\n乙\n\n', dreamOnly: true } }))
            assert(d.includes('主控之要求(原文):\n\n> 甲\n> 乙\n\n## 1. 本輪審計範圍'), d.slice(d.indexOf('## 0.'), d.indexOf('## 1.') + 40))
            let none = texts.dreamBrief(ctx([node]))
            for (let bad of [null, undefined, 'x', 5, {}, { why: 5 }, { why: null }, { why: ['x'] }, { dreamOnly: true }]) {
                assert.equal(texts.dreamBrief(ctx([node], { request: bad })), none, JSON.stringify(bad))
            }
        })

        it('任務書所指之章節號與實際章節相符(§2 審計規程、§3 彙整、§4 擴建)', () => {
            let d = texts.dreamBrief(ctx([], { request: { why: WHY, dreamOnly: true } }))
            assert(d.includes('## 2. 審計規程(逐節點)') && d.includes('## 3. 彙整與方向') && d.includes('## 4. 擴建:共用工具'))
        })

        it('無共用工具區之專案:只做夢之說明不提擴建', () => {
            let d = texts.dreamBrief(ctx([], { request: { why: WHY, dreamOnly: true }, toolbox: null }))
            assert(d.includes('**本輪沒有可審計之節點**') && !d.includes('擴建(§4)'))
        })

        it('有節點而帶要求(非只做夢):列要求之原文、不列只做夢之說明;審計照常', () => {
            let d = texts.dreamBrief(ctx([node], { request: { why: WHY, dreamOnly: false } }))
            assert(d.includes('## 0. 主控之要求\n') && d.includes('> 請以之重審現有各變體'))
            assert(!d.includes('只做夢') && !d.includes('本輪沒有可審計之節點') && !d.includes('本輪無可審計之節點。'))
            assert(d.includes('`audits` 已預填本輪各節點之 id,每個都要審'))
        })

        it('未帶要求:任務書與改前逐字相同(不出現「主控之要求」一節;交付段照舊);要求為空白字串者視同未帶', () => {
            let d = texts.dreamBrief(ctx([node]))
            assert(!d.includes('主控之要求') && !d.includes('只做夢') && !d.includes('本輪無可審計之節點。'))
            assert(d.includes('`audits` 已預填本輪各節點之 id,每個都要審'))
            assert.equal(texts.dreamBrief(ctx([node], { request: { why: '   ', dreamOnly: true } })), d)
            //無節點而未帶要求(領域不會如此呼叫; 防呆): 亦不出現新增之字樣
            let d0 = texts.dreamBrief(ctx([]))
            assert(!d0.includes('主控之要求') && !d0.includes('本輪無可審計之節點。') && d0.includes('`audits` 已預填本輪各節點之 id,每個都要審'))
            assert.equal(texts.dreamBrief(ctx([], { request: { why: '', dreamOnly: true } })), d0)
        })

        it('未帶要求之任務書逐字不變(釘死):四種情境之輸出之 sha256 前 16 字,與修改前(1.0.12)之輸出逐字相等時所取之值相同', () => {
            //取值方式:修改前之 texts.mjs 與現行之 texts.mjs 於同一組設定與同一組輸入下產出任務書(dreamBrief)與範本(dreamTemplate),
            //  兩者逐字相等(路徑字樣正規化後)才取現行輸出之雜湊記於此;任務書依設定之期間與合約而定 ⇒ 設定(settings.json)或任務書之一般文字有意改動時,
            //  須重取並於變更說明列出理由(此案之用意:任何未經說明之一般文字改動皆會使本案轉紅)
            //  重取之理由(共用工具區之擴充診斷例外): 做夢任務書多列一句「metrics/ 之擴充診斷可同名修正,改後由迴圈或補算工具重算」與檔頭註解以外之改寫會被還原
            //任務書內寫有本套件程式夾之相對路徑(codeRootRel;套件夾內為 src):測試於他處執行(例:變異用之複本)時正規化為 src
            let codeRoot = path.relative(st.FD_ROOT, path.join(FD_ROOT, 'src')).replace(/\\/g, '/')
            let sha = (s) => crypto.createHash('sha256').update(s.split(codeRoot).join('src')).digest('hex').slice(0, 16)
            let node2 = { ...node, nodeId: 'n2', arms: ['B14_pitKey'], type: 'verify', issues: ['問題甲'], from: { round: 3, arms: ['B14_pitKey'], base: null, claimKey: 'abcd1234' } }
            let cases = [
                ['一個節點', ctx([node]), 'd19e36ddb3be9072'],
                ['零個節點(防呆)', ctx([]), 'cf365e6f9331cade'],
                ['兩個節點、重做、失敗者', { ...ctx([node, node2], { failed: [{ nodeId: 'f1234567', arms: ['A01_nt'], error: '錯誤' }] }), reworkedIds: ['abcdef1234'] }, 'a740ddc2a44b3898'],
                ['無共用工具區', ctx([node], { toolbox: null }), 'ffd6627dad42eb97'],
            ]
            for (let [name, c, want] of cases) {
                assert.equal(sha(texts.dreamBrief(c)), want, name)
            }
        })

        it('做夢文件:scope.request 列於審計範圍之下一列(只做夢者另註明);未帶者不列', () => {
            let base = { round: 9, audits: [], harness: null, scope: { nodes: [], reworked: [] } }
            let md = renderDreamMd({ ...base, scope: { nodes: [], reworked: [], request: { why: WHY, dreamOnly: true } } })
            let ls = md.split('\n')
            let i = ls.findIndex((l) => l.startsWith('- 審計範圍: 0 個節點'))
            assert(i >= 0 && ls[i + 1] === '- 主控之要求(**只做夢輪次**:本輪無節點、審計 0): 評估器新增成員重抽之重放 請以之重審現有各變體', ls[i + 1])
            let md2 = renderDreamMd({ ...base, scope: { nodes: ['n1'], reworked: [], request: { why: WHY, dreamOnly: false } } })
            assert(md2.includes('- 主控之要求: 評估器新增成員重抽之重放 請以之重審現有各變體'))
            assert(!renderDreamMd(base).includes('主控之要求'))
            assert(!renderDreamMd({ ...base, scope: { nodes: [], reworked: [], request: { why: '  ' } } }).includes('主控之要求'))
            //無 scope 之舊文件照常渲染(不拋錯、不列要求);要求之文字去前後空白、換行(含 \r\n 與其前後空白)折為一個空格
            assert(!renderDreamMd({ round: 9, audits: [], harness: null }).includes('主控之要求'))
            let md3 = renderDreamMd({ ...base, scope: { nodes: [], reworked: [], request: { why: '  甲 \r\n  乙\n丙  ', dreamOnly: false } } })
            assert(md3.split('\n').includes('- 主控之要求: 甲 乙 丙'), md3.split('\n').slice(0, 6).join('|'))
        })
    })

    //接縫不用替身: 真 w-recursi + 本套件真實之領域(makeProject 之輪末鉤子 → arsi.runDream → 做夢文件 → 方向入前緣); 只有「派工」換成假的
    describe('輪末鉤子:真 w-recursi + 真領域 + 假派工', function () {
        this.timeout(120000)
        let t
        beforeEach(() => {
            t = makeTmp('dreamOnly')
        })
        afterEach(() => {
            t.cleanup()
        })
        let ARMS = ['A01_nt', 'B14_pitKey']
        //mk, 於暫存夾組裝專案; 假派工: 節點一律拋錯(不入樹)、做夢依 dream.template.json 交付(方向 1 條)
        let mk = () => {
            let st = getSettings()
            let d = path.join(t.dir, 'proj')
            st.rsi.root = path.join(d, 'rsi')
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
            let calls = { node: 0, dream: 0, briefs: [], nAudits: [] }
            let dispatch = async (role, { prompt }) => {
                if (role !== 'dream') {
                    calls.node++
                    throw new Error('fake: 節點派工例外')
                }
                calls.dream++
                let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
                let wd = path.resolve(st.FD_ROOT, m[1])
                calls.briefs.push(fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'))
                let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
                calls.nAudits.push(tpl.audits.length)
                let dream = {
                    audits: tpl.audits.map((a) => ({ nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })),
                    synthesis: { summary: '假做夢(只做夢)', worked: [], failed: [], patterns: [], prevDirections: [] },
                    guidance: { directions: [{ type: 'explore', arms: ARMS, base: null, rationale: '只做夢後給之方向' }], avoid: [], openQuestions: [], improvements: [], armProposals: [] },
                    expansion: [],
                    docsUpdated: [],
                }
                fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
                return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
            }
            let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
            P.rsi.init()
            return { P, calls, st }
        }
        let rowOf = (P) => P.rsi.store.listFrontier().find((f) => f.spec.arms.join('+') === ARMS.join('+'))
        let putExecuted = (P, arms, round) => {
            let spec = { arms, base: null }
            let id = P.idOf(spec)
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round })
            return id
        }

        it('未要求:0 個可審計之節點 ⇒ 照舊略過做夢(不派工、無做夢文件)', async () => {
            let { P, calls } = mk()
            let hk = await P.domain.hooks.afterRound({ round: 1, nodes: [] })
            assert.equal(calls.dream, 0)
            assert.equal(hk.dream, null)
            assert.deepEqual(hk.lines, ['代理式做夢:本輪無可審計之節點,略過'])
            assert.equal(P.records.getDreamDoc(1), null)
        })

        it('已要求:0 個節點仍派做夢一次;任務書含要求之原文;做夢文件記 scope.request、審計 0;方向入前緣;回傳帶 dreamOnly;要求取用即清除', async () => {
            let { P, calls } = mk()
            let WHY = '工具更新:請重審現有各變體\n第二行'
            assert.deepEqual(P.requestDreamOnly({ why: `  ${WHY}  ` }), { why: WHY }, '前後空白去除')
            let hk = await P.domain.hooks.afterRound({ round: 1, nodes: [] })
            assert.equal(calls.dream, 1)
            assert(calls.briefs[0].includes('## 0. 主控之要求(本輪為「只做夢」輪次)') && calls.briefs[0].includes('> 工具更新:請重審現有各變體\n> 第二行'))
            assert(hk.dream && hk.dream.dreamOnly === true && hk.dream.round === 1)
            assert.equal(hk.lines[0], '只做夢輪次(主控要求;本輪無節點、審計 0):工具更新:請重審現有各變體', '摘要首列只取要求之第一行')
            assert(hk.lines.some((l) => l.includes('審計 0 節點 ⇒ 採納 0、重做 0(成功 0)、刪除 0;方向 1 條(入前緣 1)')), JSON.stringify(hk.lines))
            let dd = P.records.getDreamDoc(1)
            assert.deepEqual(dd.scope, { nodes: [], reworked: [], request: { why: WHY, dreamOnly: true } })
            assert.deepEqual(dd.audits, [])
            assert(fs.readFileSync(P.records.paths.dreamMd(1), 'utf8').includes('- 主控之要求(**只做夢輪次**'))
            assert.equal(rowOf(P).status, 'proposed', '做夢之方向入前緣')
            //要求只對一次鉤子有效
            let hk2 = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.equal(calls.dream, 1, '第二次未再派做夢')
            assert.equal(hk2.dream, null)
            assert.equal(P.pendingDream(), null, '只做夢輪次不被當成「做夢未交付」')
        })

        it('要求之文字含 Windows 換行(\\r\\n):摘要首列不帶 \\r、任務書逐行引用不帶 \\r、做夢文件之要求併為一行;首行逾 160 字者截斷', async () => {
            let { P, calls } = mk()
            let long = '長'.repeat(200)
            P.requestDreamOnly({ why: `${String.fromCharCode(65279)}首行\r\n第二行\r\n${long}\r\n` })
            let hk = await P.domain.hooks.afterRound({ round: 1, nodes: [] })
            assert.equal(hk.lines[0], '只做夢輪次(主控要求;本輪無節點、審計 0):首行', '首列只取首行、不帶 \\r')
            assert(calls.briefs[0].includes('> 首行\n> 第二行\n> '), '逐行引用,不帶 \\r')
            assert(!calls.briefs[0].includes('\r'))
            let md = fs.readFileSync(P.records.paths.dreamMd(1), 'utf8')
            assert(md.includes(`- 主控之要求(**只做夢輪次**:本輪無節點、審計 0): 首行 第二行 ${long}`), '併為一行')
            //首行本身逾 160 字
            P.requestDreamOnly({ why: long })
            let hk2 = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.equal(hk2.lines[0], `只做夢輪次(主控要求;本輪無節點、審計 0):${'長'.repeat(160)}`)
        })

        it('經引擎之整輪(rsi.auto):節點皆未入樹而已要求 ⇒ 鉤子由引擎呼叫、照派做夢(審計 0)', async () => {
            let { P, calls } = mk()
            P.requestDreamOnly({ why: '經引擎之整輪' })
            let res = await P.rsi.auto({ by: 'test', protocol: { round: peekRound(P.rsi.paths) }, arms: 1, novelty: 1, workers: 1, noDream: true })
            assert.equal(calls.node, 1, '節點派工一次(拋錯、不入樹)')
            assert.equal(calls.dream, 1)
            assert(res.hook && res.hook.dream && res.hook.dream.dreamOnly === true, JSON.stringify(res.hook && res.hook.lines))
            assert.deepEqual(P.records.getDreamDoc(res.round).scope.request, { why: '經引擎之整輪', dreamOnly: true })
        })

        it('requestDreamOnly:要求須為非空字串(否則拋 V19 訊息、不登記、不回顯輸入值);pendingReauditIds 只回樹上已執行之待重審節點', async () => {
            let { P, calls } = mk()
            for (let bad of [undefined, null, {}, { why: '' }, { why: '   ' }, { why: 3 }, { why: ['x'] }, { why: Object('機密值') }]) {
                assert.throws(() => P.requestDreamOnly(bad), (err) => err.message === 'invalid opt.why: must be a non-empty string', JSON.stringify(bad))
            }
            let hk = await P.domain.hooks.afterRound({ round: 1, nodes: [] })
            assert.equal(calls.dream, 0, '拋錯者未登記')
            assert.equal(hk.dream, null)
            assert.deepEqual(P.pendingReauditIds(), [])
            P.setState({ pendingReaudit: ['nonexistent0000000000'] })
            assert.deepEqual(P.pendingReauditIds(), [], '不在樹上者不計')
            let id = putExecuted(P, ['A01_nt'], 1)
            P.setState({ pendingReaudit: ['nonexistent0000000000', id] })
            assert.deepEqual(P.pendingReauditIds(), [id], '在樹上且已執行者計入')
            //在樹上而不是已執行者(例:前緣之提案被閘門拒絕後之存根)不計
            let spec = { arms: ['B14_pitKey'], base: null }
            let idP = P.idOf(spec)
            P.rsi.store.putNode({ id: idP, spec, specHash: specHash(spec), status: 'planned', parents: [], round: 1 })
            P.setState({ pendingReaudit: [idP, id] })
            assert.deepEqual(P.pendingReauditIds(), [id], '非已執行者不計')
        })

        it('輪末鉤子:待重審之節點與本輪已執行之節點重複者只列一次(審計範圍不重複)', async () => {
            let { P, calls } = mk()
            let id = putExecuted(P, ['A01_nt'], 1)
            P.setState({ pendingReaudit: [id] })
            await P.domain.hooks.afterRound({ round: 2, nodes: [P.rsi.store.getNode(id)] })
            assert.deepEqual(calls.nAudits, [1], '同一節點不重複列入審計')
            assert.deepEqual(P.records.getDreamDoc(2).scope.nodes, [id])
        })

        it('鉤子於取用要求之後才出錯(待重審名單損毀 ⇒ 鉤子拋錯):要求已清除、不殘留至下一次(無關之)鉤子', async () => {
            let { P, calls } = mk()
            P.setState({ pendingReaudit: {} })
            P.requestDreamOnly({ why: '將於損毀之鉤子被取用' })
            await assert.rejects(() => P.domain.hooks.afterRound({ round: 1, nodes: [] }), TypeError)
            assert.equal(calls.dream, 0)
            P.setState({ pendingReaudit: [] })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.equal(calls.dream, 0, '要求不殘留')
            assert.deepEqual(hk.lines, ['代理式做夢:本輪無可審計之節點,略過'])
        })

        it('認領中之節點(claimedNodeIds):只計樹上 planned / running 者', async () => {
            let { P } = mk()
            assert.deepEqual(P.claimedNodeIds(), [])
            let mkNode = (arms, status) => {
                let spec = { arms, base: null }
                let id = P.idOf(spec)
                P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status, parents: [], round: 1, claim: { by: 'x', pid: 99999999, at: new Date().toISOString() } })
                return id
            }
            let a = mkNode(['A01_nt'], 'running')
            let b = mkNode(['B14_pitKey'], 'planned')
            mkNode(['A04_act'], 'executed')
            assert.deepEqual(P.claimedNodeIds().sort(), [a, b].sort())
        })

        it('runDream 之 context.request 之 why 為空白或非字串者視同未帶:做夢文件之 scope 與改前相同(不新增 request)', async () => {
            let { P } = mk()
            let ctx = (request) => ({ nodes: [], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '', toolbox: null, ...(request === undefined ? {} : { request }) })
            let n = 5
            for (let request of [undefined, null, { why: '  ' }, { why: 5 }, {}, { dreamOnly: true }]) {
                await P.arsi.runDream({ round: ++n, nodeIds: [], reworkedIds: [], context: ctx(request) })
                assert.deepEqual(P.records.getDreamDoc(n).scope, { nodes: [], reworked: [] }, JSON.stringify(request))
            }
            await P.arsi.runDream({ round: ++n, nodeIds: [], reworkedIds: [], context: ctx({ why: '有效', dreamOnly: true }) })
            assert.deepEqual(P.records.getDreamDoc(n).scope, { nodes: [], reworked: [], request: { why: '有效', dreamOnly: true } })
        })

        it('拋錯之登記不覆蓋先前已登記之要求(先登記者仍有效)', async () => {
            let { P, calls } = mk()
            P.requestDreamOnly({ why: '先登記者' })
            assert.throws(() => P.requestDreamOnly({ why: '' }), /invalid opt\.why/)
            await P.domain.hooks.afterRound({ round: 1, nodes: [] })
            assert.equal(calls.dream, 1)
            assert(calls.briefs[0].includes('> 先登記者'))
        })

        it('待重審之節點:輪末鉤子與 pendingReauditIds 同一來源 —— 有待重審者(無要求)照常派做夢、審計 1;已執行之重複者不重列', async () => {
            let { P, calls } = mk()
            let id = putExecuted(P, ['A01_nt'], 1)
            P.setState({ pendingReaudit: [id] })
            assert.deepEqual(P.pendingReauditIds(), [id])
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.equal(calls.dream, 1)
            assert.deepEqual(calls.nAudits, [1])
            assert(!calls.briefs[0].includes('主控之要求'), '未要求 ⇒ 任務書不列')
            assert(hk.dream && hk.dream.dreamOnly === undefined)
            //帶要求且有待重審者 ⇒ 要求之原文列出但不標只做夢
            P.setState({ pendingReaudit: [id] })
            P.requestDreamOnly({ why: '有待重審者' })
            let hk2 = await P.domain.hooks.afterRound({ round: 3, nodes: [] })
            assert.deepEqual(calls.nAudits, [1, 1])
            assert(calls.briefs[1].includes('## 0. 主控之要求\n') && !calls.briefs[1].includes('只做夢'))
            assert(hk2.dream && hk2.dream.dreamOnly === undefined)
            assert.equal(hk2.lines[0], '主控對本輪做夢之要求:有待重審者')
            assert.deepEqual(P.records.getDreamDoc(3).scope.request, { why: '有待重審者', dreamOnly: false })
        })

        it('乾跑之計畫不寫任何檔(起跑前之計畫判斷所依:rsi.explore({ dry: true }) 前後狀態根之檔案與修改時間不變)', async () => {
            let { P, st } = mk()
            let snap = () => {
                let out = []
                let walk = (d) => {
                    for (let e of fs.readdirSync(d, { withFileTypes: true })) {
                        let fp = path.join(d, e.name)
                        if (e.isDirectory()) {
                            out.push(`${fp}/`)
                            walk(fp)
                        }
                        else {
                            let s = fs.statSync(fp)
                            out.push(`${fp}|${s.size}|${s.mtimeMs}`)
                        }
                    }
                }
                walk(path.dirname(st.rsi.root))
                return out.sort()
            }
            let before = snap()
            let r = await P.rsi.explore({ dry: true, arms: 2, novelty: 2 })
            assert.equal(r.dry, true)
            assert(Array.isArray(r.items) && Array.isArray(r.rejected))
            assert.deepEqual(snap(), before)
        })
    })

    //命令列之接線: 以套件之 src/cli/rsi.mjs 於合成之專案根實跑(派工套件為替身: 做夢之替身照範本交付 dream.json 並更新兩份指引文件)
    describe('命令列 g_rsi.mjs --mode round(合成專案根、替身派工套件)', function () {
        this.timeout(300000)
        let t
        before(() => {
            t = makeTmp('dreamOnlyCli')
        })
        after(() => {
            t.cleanup()
        })
        let STUB = `
const fs = require('fs')
const path = require('path')
const rec = (x) => fs.appendFileSync(process.env.QSTUB_LOG, JSON.stringify(x) + '\\n')
module.exports = {
    providers: [{ id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' }],
    readEnvFile: () => ({ OPENCODE_GO_KEYS: 'oc_sk_TESTKEY00000001' }),
    opencodeGoUsage: async () => ({ ok: true, limited: false, usage: { rolling: { percent: 0, resetsAt: '2026-01-01T05:00:00.000Z' }, weekly: { percent: 10, resetsAt: '2026-01-05T00:00:00.000Z' } } }),
    dispatchOpencode: async (prompt, opts) => {
        rec({ fn: 'dispatchOpencode' })
        return { ok: false, errorType: 'exec', error: 'Exit code 1', stdout: '', durationMs: 5 }
    },
    dispatchClaude: async (prompt, opts) => {
        const m = /請閱讀 (\\S+)\\/brief\\.md/.exec(prompt)
        const wd = path.resolve(opts.cwd, m[1])
        const brief = fs.readFileSync(path.join(wd, 'brief.md'), 'utf8')
        const tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
        rec({ fn: 'dispatchClaude', nAudits: tpl.audits.length, hasRequest: brief.includes('## 0. 主控之要求(本輪為「只做夢」輪次)'), quoted: brief.includes('> 請重審現有各變體') })
        if (process.env.QSTUB_DREAM === 'fail') {
            return { ok: false, errorType: 'exec', error: 'Exit code 1', stdout: '', durationMs: 5 }
        }
        fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify({ audits: [], synthesis: { summary: '替身做夢(只做夢)', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [{ kind: 'loop', target: '摘要檢查', what: '改進內容甲' }], armProposals: [] }, expansion: [], docsUpdated: [] }))
        if (process.env.QSTUB_DREAM === 'nosgud') {
            return { ok: true, stdout: 'DONE', durationMs: 5 }
        }
        for (const f of ['sgud/state/state.md', 'sgud/exp/experience.md']) {
            fs.mkdirSync(path.dirname(path.join(opts.cwd, f)), { recursive: true })
            fs.writeFileSync(path.join(opts.cwd, f), '替身做夢所更新\\n')
        }
        return { ok: true, stdout: 'DONE', durationMs: 5 }
    },
    getQuotaClaude: async () => ({ ok: true, windows: [{ label: 'week', usedPercent: 10, resetAt: '' }] }),
}
`
        //mkProject, 合成專案根; emptyPlan: 臂目錄基底之各臂皆設為不可選 ⇒ 下一輪之計畫為 0 個節點(前緣為空)
        //  only: 只有所列之臂可選(其餘不可選)
        let mkProject = (name, { emptyPlan, only = null }) => {
            let dir = path.join(t.dir, name)
            fs.mkdirSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai'), { recursive: true })
            fs.mkdirSync(path.join(dir, 'arms'), { recursive: true })
            let base = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'arms', 'base.json'), 'utf8'))
            if (emptyPlan) {
                base.arms = base.arms.map((a) => ({ ...a, selectable: only ? only.includes(a.id) : false }))
            }
            fs.writeFileSync(path.join(dir, 'arms', 'base.json'), JSON.stringify(base))
            writeSynthLedger(path.join(dir, 'ledger'), { n: 6, nBars: 400 })
            let st = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            st.eval.ledgerDir = './ledger'
            st.dispatch = { skillsRoot: path.join(dir, 'skills'), envFile: path.join(dir, '.env') }
            st.rsi = { ...st.rsi, nodesPerRound: 1, parallelNodes: 1 }
            st.resources = {}
            st.agents = { node: { kind: 'opencode', id: 'ocgo:opencode-go/m', variant: 'high', timeoutMin: 1 }, dream: { kind: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', timeoutMin: 1 } }
            fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(st, null, 1))
            fs.writeFileSync(path.join(dir, '.env'), 'OPENCODE_GO_KEYS=oc_sk_TESTKEY00000001\n')
            fs.writeFileSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }))
            fs.writeFileSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), STUB)
            fs.writeFileSync(path.join(dir, 'why.txt'), '成員重抽之重放已可用\n請重審現有各變體\n', 'utf8')
            return dir
        }
        //seedState, 以專案根之設定(路徑改指專案夾)於測試行程內預先寫入狀態根: 前緣之提案、已執行之節點、待重審名單、做夢文件; 與命令列行程讀同一組檔案
        let seedState = (dir, fn) => {
            let st = getSettings()
            st.rsi.root = path.join(dir, 'rsi')
            st.records = { nodeDir: path.join(dir, 'rsi/records/nodes'), dreamDir: path.join(dir, 'rsi/records/dreams'), trashDir: path.join(dir, 'rsi/records/trash'), workDir: path.join(dir, 'rsi/work'), toolboxDir: path.join(dir, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(dir, 'ledger')
            let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'seed' }), gate: null, catalogFile: path.join(dir, 'seed_catalog.json') })
            P.rsi.init()
            fn(P)
        }
        let runCli = (dir, args, env = {}) => {
            let fpLog = path.join(dir, 'calls.log')
            fs.rmSync(fpLog, { force: true })
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs'), ...args], { cwd: t.dir, env: { ...process.env, ARSI_ROOT: dir, QSTUB_LOG: fpLog, ...env }, windowsHide: true, encoding: 'utf8', timeout: 240000 })
            let lines = (fp) => (fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)) : [])
            return { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls: lines(fpLog), events: lines(path.join(dir, 'rsi', 'logs', 'events.jsonl')) }
        }
        let roundDirs = (dir) => (fs.existsSync(path.join(dir, 'rsi', 'rounds')) ? fs.readdirSync(path.join(dir, 'rsi', 'rounds')) : [])

        it('一般輪次、前緣為空 ⇒ 不起空輪:離開碼 0、事件 run-start → run-done(rounds 0、reason frontier-empty)、不建輪夾、不派工、狀態檔記原因', () => {
            let dir = mkProject('empty', { emptyPlan: true })
            let r = runCli(dir, ['--mode', 'round'])
            assert.equal(r.status, 0, r.out)
            assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'run-done'], r.out)
            let done = r.events[1]
            assert.deepEqual([done.rounds, done.reason], [0, 'frontier-empty'])
            assert(/前緣為空/.test(done.stopped), done.stopped)
            assert.deepEqual(roundDirs(dir), [], '未耗輪號')
            assert.deepEqual(r.calls, [], '未派任何 agent')
            assert.equal(trailingFailures(r.events), 0, '不記為失敗輪')
            let stt = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'STATUS.json'), 'utf8'))
            assert.deepEqual([stt.done, stt.run.done, stt.run.reason], [true, 0, 'frontier-empty'])
            //連續失敗計數不因多次起跑而累積:再起一次仍照常不起(不被起跑前之自檢擋成 skipped)
            let r2 = runCli(dir, ['--mode', 'round'])
            assert.equal(r2.status, 0, r2.out)
            assert.deepEqual(r2.events.map((e) => e.event), ['run-start', 'run-done', 'run-start', 'run-done'])
            assert.deepEqual(roundDirs(dir), [])
        })

        it('未帶 --dream-only 而計畫有節點(可選之臂尚未試)⇒ 照常起輪(不受前緣為空之判斷影響):事件 round-done、建輪夾、派節點', () => {
            let dir = mkProject('normal', { emptyPlan: false })
            let r = runCli(dir, ['--mode', 'round'])
            assert.equal(r.status, 0, r.out)
            assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'round-done', 'run-done'], r.out)
            assert.equal(r.events[2].reason, undefined)
            assert.deepEqual(roundDirs(dir), ['r001'])
            assert(r.calls.some((c) => c.fn === 'dispatchOpencode'), JSON.stringify(r.calls))
            assert.equal(r.events[1].dreamOnly, undefined)
            assert.equal(r.events[0].dreamOnly, undefined)
            let stt = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'STATUS.json'), 'utf8'))
            assert.equal('dreamOnly' in stt, false, '一般輪次之狀態檔不帶 dreamOnly 鍵(與改前逐位相同之鍵集)')
            assert(!/只做夢輪次\(主控要求\)/.test(r.out), '一般輪次之開始日誌不標只做夢')
            let R = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'rounds', 'r001', 'ROUND.json'), 'utf8'))
            assert.equal(R.dreamOnly, undefined, '一般輪次之 ROUND.json 不帶 dreamOnly')
            let digest = fs.readFileSync(path.join(dir, 'rsi', 'rounds', 'r001', 'DIGEST.md'), 'utf8')
            assert(digest.includes('## 一眼看完') && !digest.includes('只做夢輪次'), '一般輪次之一頁摘要照常產生、不列只做夢')
        })

        it('只做夢輪次:未給 --file、檔不存在或檔為空 ⇒ 印 V19 訊息(不回顯路徑)與用法、離開碼 2、不取鎖、不記事件', () => {
            let dir = mkProject('usage', { emptyPlan: true })
            fs.writeFileSync(path.join(dir, 'blank.txt'), '  \n', 'utf8')
            //旗標無值時(argOf 回 true)不得被當成檔名 'true' 去讀: 工作目錄(測試之 t.dir)下放一個名為 true 之有內容檔
            fs.writeFileSync(path.join(t.dir, 'true'), '不應被讀到之要求\n', 'utf8')
            for (let extra of [[], ['--file'], ['--file', path.join(dir, 'nope.txt')], ['--file', path.join(dir, 'blank.txt')]]) {
                let r = runCli(dir, ['--mode', 'round', '--dream-only', ...extra])
                assert.equal(r.status, 2, r.out)
                assert(/invalid --file: must be the path of a readable, non-empty UTF-8 text file/.test(r.out), r.out)
                assert(/用法: node g_rsi\.mjs --mode round --dream-only --file/.test(r.out), r.out)
                assert(!r.out.includes('nope.txt') && !r.out.includes('blank.txt'), '訊息不回顯輸入之路徑(V20)')
                assert.deepEqual(r.events, [])
                assert(!fs.existsSync(path.join(dir, 'rsi', 'logs', 'round.lock')), '不取鎖')
            }
            fs.rmSync(path.join(t.dir, 'true'), { force: true })
        })

        it('只做夢輪次:--file 之檔名為純數字(argOf 會轉為數字;前導零者轉後為另一個檔名)者依命令列原字串讀取', () => {
            let dir = mkProject('numfile', { emptyPlan: true })
            for (let name of ['777', '001', '0']) {
                fs.writeFileSync(path.join(t.dir, name), '請重審現有各變體\n', 'utf8')
                fs.rmSync(path.join(dir, 'rsi'), { recursive: true, force: true })
                let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', name])
                fs.rmSync(path.join(t.dir, name), { force: true })
                assert.equal(r.status, 0, `${name}: ${r.out}`)
                assert.deepEqual(r.calls, [{ fn: 'dispatchClaude', nAudits: 0, hasRequest: true, quoted: true }], name)
            }
        })

        it('只做夢輪次:檔為無效之 UTF-8(例:UTF-16 或隨機位元組)⇒ 與讀不到同:V19 訊息、離開碼 2、不取鎖、不記事件;含 BOM 之有效 UTF-8 照收', () => {
            let dir = mkProject('badutf', { emptyPlan: true })
            let fpBad = path.join(dir, 'bad.txt')
            fs.writeFileSync(fpBad, Buffer.from([0xFF, 0xFE, 0x41, 0x00]))
            let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', fpBad])
            assert.equal(r.status, 2, r.out)
            assert(/invalid --file: must be the path of a readable, non-empty UTF-8 text file/.test(r.out), r.out)
            assert.deepEqual(r.events, [])
            assert(!fs.existsSync(path.join(dir, 'rsi', 'logs', 'round.lock')))
            let fpBom = path.join(dir, 'bom.txt')
            fs.writeFileSync(fpBom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('請重審現有各變體\r\n', 'utf8')]))
            let r2 = runCli(dir, ['--mode', 'round', '--dream-only', '--file', fpBom])
            assert.equal(r2.status, 0, r2.out)
            assert.deepEqual(r2.calls, [{ fn: 'dispatchClaude', nAudits: 0, hasRequest: true, quoted: true }])
        })

        it('只做夢輪次:輸入錯誤先於專案之組裝 —— 專案缺帳本而又未給 --file ⇒ 仍為 invalid --file、離開碼 2(不是缺帳本之錯)', () => {
            let dir = mkProject('noLedger', { emptyPlan: true })
            fs.rmSync(path.join(dir, 'ledger'), { recursive: true, force: true })
            let r = runCli(dir, ['--mode', 'round', '--dream-only'])
            assert.equal(r.status, 2, r.out)
            assert(/invalid --file: must be/.test(r.out) && !/帳本/.test(r.out), r.out)
            let r2 = runCli(dir, ['--mode', 'round'])
            assert.notEqual(r2.status, 2, '未帶 --dream-only 者不受影響(專案組裝之錯誤照舊)')
        })

        it('遺留之認領(planned / running 而認領者行程已死):計畫為 0 個節點(乾跑視為已占用)時一般輪次照起 —— 由正式之探索回收後重新計畫;只做夢輪次不受理', () => {
            let dir = mkProject('claimed', { emptyPlan: true, only: ['A01_nt'] })
            seedState(dir, (P) => {
                let spec = { arms: ['A01_nt'], base: null }
                P.rsi.store.putNode({ id: P.idOf(spec), spec, specHash: specHash(spec), status: 'running', parents: [], round: 1, claim: { by: 'dead', pid: 99999999, at: new Date().toISOString() } })
            })
            //只做夢輪次:不受理(認領中者由正式之探索回收,屬一般輪次之事)
            let r0 = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt')])
            assert.equal(r0.status, 0, r0.out)
            assert.deepEqual([r0.events[r0.events.length - 1].reason, r0.events[r0.events.length - 1].rounds], ['dream-only-busy', 0])
            assert(/認領中之節點 1 個/.test(r0.events[r0.events.length - 1].stopped))
            assert.deepEqual(roundDirs(dir), [])
            //一般輪次:照起(乾跑為空而不起 ⇒ 遺留之認領永遠不被回收)
            let r = runCli(dir, ['--mode', 'round'])
            assert.equal(r.status, 0, r.out)
            let evs = r.events.slice(r0.events.length)
            assert.deepEqual(evs.map((e) => e.event), ['run-start', 'round-done', 'run-done'], r.out)
            assert.equal(evs[2].reason, undefined)
            assert.deepEqual(roundDirs(dir), ['r001'])
            assert(r.calls.some((c) => c.fn === 'dispatchOpencode'), '回收後重新計畫、派了節點:' + JSON.stringify(r.calls))
        })

        it('待重審名單損毀(arsi_state.json 之 pendingReaudit 非陣列):計畫判斷之讀取拋錯不擋、不留孤立之 run-start —— 照原樣起輪(輪末鉤子拋錯記為鉤子失敗),事件有結束', () => {
            let dir = mkProject('badState', { emptyPlan: false })
            fs.mkdirSync(path.join(dir, 'rsi'), { recursive: true })
            fs.writeFileSync(path.join(dir, 'rsi', 'arsi_state.json'), JSON.stringify({ pendingReaudit: {} }), 'utf8')
            let r = runCli(dir, ['--mode', 'round'])
            assert.equal(r.status, 0, r.out)
            let names = r.events.map((e) => e.event)
            assert.deepEqual([names[0], names[names.length - 1]], ['run-start', 'run-done'], r.out)
            let rd = r.events.find((e) => e.event === 'round-done')
            assert(rd && rd.hookFailed === true && rd.ok === false, JSON.stringify(rd))
        })

        it('乾跑本身拋錯者不擋計畫判斷:策略檔(rsi/policies/current.mjs)損毀 ⇒ 乾跑與正式之探索皆拋錯,由正式之探索照原樣報錯(事件 run-failed、離開碼 1),不被記為前緣為空、亦不無事件而崩潰', () => {
            let dir = mkProject('dryThrow', { emptyPlan: true })
            //先以 --mode init 建狀態根與策略檔, 再把策略檔改為無 default 匯出
            let ri = runCli(dir, ['--mode', 'init'])
            assert.equal(ri.status, 0, ri.out)
            let fpPolicy = path.join(dir, 'rsi', 'policies', 'current.mjs')
            assert(fs.existsSync(fpPolicy), '策略檔存在')
            fs.writeFileSync(fpPolicy, 'export let notDefault = 1\n', 'utf8')
            let r = runCli(dir, ['--mode', 'round'])
            assert.equal(r.status, 1, r.out)
            assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'run-failed'], r.out)
            assert(/current\.mjs/.test(r.events[1].error), r.events[1].error)
            assert.deepEqual(roundDirs(dir), [], '未起輪')
        })

        it('只做夢輪次、前緣為空 ⇒ 起一輪:做夢派工一次(審計 0、任務書含要求)、事件 round-done(ok、dreamOnly)、ROUND.json 與一頁摘要記要求與改進項(取 what)、做夢文件記 scope.request;其後之一般輪次仍因前緣為空而不起', () => {
            let dir = mkProject('dream', { emptyPlan: true })
            let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt'), '--rounds', '3'])
            assert.equal(r.status, 0, r.out)
            assert.deepEqual(r.calls, [{ fn: 'dispatchClaude', nAudits: 0, hasRequest: true, quoted: true }])
            assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'round-done', 'run-done'], r.out)
            assert.deepEqual([r.events[0].dreamOnly, r.events[0].rounds], [true, 1], '只跑 1 輪(--rounds 不採)')
            let rd = r.events[1]
            assert.deepEqual([rd.round, rd.ok, rd.dreamOnly, rd.nExecuted, rd.hookFailed], [1, true, true, 0, false], JSON.stringify(rd))
            assert.deepEqual([r.events[2].rounds, r.events[2].stopped, r.events[2].reason], [1, null, undefined])
            let R = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'rounds', 'r001', 'ROUND.json'), 'utf8'))
            assert.deepEqual(R.dreamOnly, { why: '成員重抽之重放已可用\n請重審現有各變體' })
            assert.equal(R.hook.lines[0], '只做夢輪次(主控要求;本輪無節點、審計 0):成員重抽之重放已可用')
            let digest = fs.readFileSync(path.join(dir, 'rsi', 'rounds', 'r001', 'DIGEST.md'), 'utf8')
            assert(digest.includes('- **只做夢輪次**(主控要求;本輪無節點、審計 0):成員重抽之重放已可用 請重審現有各變體'), digest.slice(0, 600))
            assert(digest.includes('- 〔loop〕摘要檢查:改進內容甲'), '改進項取 what(做夢文件之欄位)')
            let dd = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'records', 'dreams', 'r001.json'), 'utf8'))
            assert.deepEqual(dd.scope.request, { why: '成員重抽之重放已可用\n請重審現有各變體', dreamOnly: true })
            let st = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'STATUS.json'), 'utf8'))
            assert.equal(st.dreamOnly, true)
            assert(/;只做夢輪次\(主控要求\)\)=====/.test(r.out), '開始日誌標只做夢')
            //其後之一般輪次: 做夢未給方向 ⇒ 仍為前緣為空
            let r2 = runCli(dir, ['--mode', 'round'])
            assert.equal(r2.status, 0, r2.out)
            assert.equal(r2.events[r2.events.length - 1].reason, 'frontier-empty')
            assert.deepEqual(roundDirs(dir), ['r001'])
            assert.deepEqual(r2.calls, [])
            let st2 = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'STATUS.json'), 'utf8'))
            assert.equal('dreamOnly' in st2, false, '其後之一般執行不沿用上次只做夢之標記')
            assert.equal(st2.run.reason, 'frontier-empty')
            //補做夢不把只做夢輪次當成「做夢未交付」(樹上無已執行之節點)⇒ 其後之起跑不補做夢
            assert(!/補做夢/.test(r2.out), r2.out)
        })

        it('一頁摘要之改進項:取 what;舊欄 change、spec 為後備;三者並存時 what 優先', () => {
            let dir = mkProject('digest', { emptyPlan: true })
            let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt')])
            assert.equal(r.status, 0, r.out)
            let fpDream = path.join(dir, 'rsi', 'records', 'dreams', 'r001.json')
            let dd = JSON.parse(fs.readFileSync(fpDream, 'utf8'))
            dd.guidance.improvements = [
                { kind: 'loop', target: 'T甲', what: '新欄之內容' },
                { kind: 'tool', target: 'T乙', change: '舊欄 change 之內容' },
                { kind: 'node', target: 'T丙', spec: '舊欄 spec 之內容' },
                { kind: 'dream', target: 'T丁', what: '優先之 what', change: '被蓋過之 change', spec: '被蓋過之 spec' },
                { kind: 'score', target: 'T戊' },
                { kind: 'validation', target: 'T己', change: '舊欄 change 先於 spec', spec: '被蓋過之 spec 己' },
            ]
            fs.writeFileSync(fpDream, JSON.stringify(dd), 'utf8')
            let digestOf = () => spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'roundDigest.mjs'), '1'], { cwd: t.dir, env: { ...process.env, ARSI_ROOT: dir }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            let g = digestOf()
            assert.equal(g.status, 0, g.stderr)
            assert(g.stdout.includes('- **只做夢輪次**(主控要求;本輪無節點、審計 0):'), '只做夢輪次之摘要列出要求')
            assert(g.stdout.split('\n').includes('- 〔validation〕T己:舊欄 change 先於 spec'), g.stdout)
            //ROUND.json 之 dreamOnly 缺 why 或 why 非字串(舊資料、手改)⇒ 不列、不拋錯
            let fpRound = path.join(dir, 'rsi', 'rounds', 'r001', 'ROUND.json')
            let R = JSON.parse(fs.readFileSync(fpRound, 'utf8'))
            for (let bad of [{}, { why: 5 }, null]) {
                fs.writeFileSync(fpRound, JSON.stringify({ ...R, dreamOnly: bad }), 'utf8')
                let g2 = digestOf()
                assert.equal(g2.status, 0, g2.stderr)
                assert(!g2.stdout.includes('- **只做夢輪次**'), JSON.stringify(bad))
            }
            let ls = g.stdout.split('\n')
            assert(ls.includes('- 〔loop〕T甲:新欄之內容'), g.stdout)
            assert(ls.includes('- 〔tool〕T乙:舊欄 change 之內容'), g.stdout)
            assert(ls.includes('- 〔node〕T丙:舊欄 spec 之內容'), g.stdout)
            assert(ls.includes('- 〔dream〕T丁:優先之 what'), g.stdout)
            assert(ls.includes('- 〔score〕T戊:'), '三欄皆無者冒號後為空')
            assert(!g.stdout.includes('被蓋過'))
        })

        it('只做夢輪次而做夢已交付、輪末回調失敗(做夢未更新專案之指引文件)⇒ 事件 round-done(ok false;delivered 為真仍不算成功)、停止於該輪', () => {
            let dir = mkProject('dreamNoSgud', { emptyPlan: true })
            let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt')], { QSTUB_DREAM: 'nosgud' })
            assert.equal(r.status, 0, r.out)
            let rd = r.events.find((e) => e.event === 'round-done')
            assert.deepEqual([rd.ok, rd.dreamOnly, rd.hookFailed], [false, true, true], JSON.stringify(rd))
            let dd = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'records', 'dreams', 'r001.json'), 'utf8'))
            assert.deepEqual(dd.scope.request.dreamOnly, true, '做夢文件已交付(只是未更新指引文件)')
            assert(/輪末回調失敗/.test(r.events[r.events.length - 1].stopped), JSON.stringify(r.events[r.events.length - 1]))
        })

        it('只做夢輪次而做夢未交付 ⇒ 事件 round-done(ok false、dreamOnly);計入連續失敗', () => {
            let dir = mkProject('dreamFail', { emptyPlan: true })
            let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt')], { QSTUB_DREAM: 'fail' })
            assert.equal(r.status, 0, r.out)
            let rd = r.events.find((e) => e.event === 'round-done')
            assert.deepEqual([rd.ok, rd.dreamOnly, rd.hookFailed], [false, true, true], JSON.stringify(rd))
            assert.equal(trailingFailures(r.events), 1)
        })

        it('只做夢輪次而計畫有節點(可選之臂尚未試)⇒ 不受理:離開碼 0、事件 run-done(rounds 0、reason dream-only-busy)、不建輪夾、不派工', () => {
            let dir = mkProject('busy', { emptyPlan: false })
            let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt'), '--rounds', '2'])
            assert.equal(r.status, 0, r.out)
            assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'run-done'], r.out)
            assert.deepEqual([r.events[0].dreamOnly, r.events[0].rounds, r.events[1].total], [true, 1, 1], '只跑 1 輪(--rounds 不採;不起之情形亦然)')
            let stb = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'STATUS.json'), 'utf8'))
            assert.deepEqual([stb.dreamOnly, stb.run.reason, stb.run.done, stb.done], [true, 'dream-only-busy', 0, true], '不起之情形之狀態檔描述本次執行')
            assert.deepEqual([r.events[1].rounds, r.events[1].reason], [0, 'dream-only-busy'])
            assert(/不受理只做夢輪次/.test(r.events[1].stopped) && /起一般輪次即可/.test(r.events[1].stopped))
            assert.deepEqual(roundDirs(dir), [])
            assert.deepEqual(r.calls, [])
        })

        it('計畫判斷之 nRejected 接線:計畫 0 個節點而有閘門拒絕(前緣之提案掛在已不可選之臂)⇒ 照起(該輪結案前緣之提案);連跑時次輪前緣已空 ⇒ 不起(frontier-empty)', () => {
            let dir = mkProject('rejected', { emptyPlan: true })
            seedState(dir, (P) => {
                let spec = { arms: ['A01_nt'], base: null }
                P.rsi.store.pushFrontier([{ spec, specHash: specHash(spec), kind: 'arm', reason: '測試用之前緣提案', origin: { topic: 'dream', operator: 'dream', round: 1 }, priority: 1 }])
            })
            let dry = runCli(dir, ['--mode', 'dry'])
            assert(/\(拒\) A01_nt: 臂 A01_nt 不可選/.test(dry.out) && /計畫\(0 個節點/.test(dry.out), dry.out)
            let r = runCli(dir, ['--mode', 'round', '--rounds', '2'])
            assert.equal(r.status, 0, r.out)
            assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'round-done', 'run-done'], r.out)
            assert.deepEqual([r.events[1].round, r.events[1].nExecuted], [1, 0], '有閘門拒絕 ⇒ 起了第 1 輪')
            assert.deepEqual([r.events[2].rounds, r.events[2].reason], [1, 'frontier-empty'], '第 2 輪起之計畫判斷:拒絕之提案已結案 ⇒ 前緣為空')
            assert.deepEqual(roundDirs(dir), ['r001'], '前緣為空之第 2 輪未耗輪號')
            assert.deepEqual(r.calls, [])
        })

        it('計畫判斷之 nReaudit 接線:計畫 0 個節點而有待重審之節點 ⇒ 照起、做夢審計該節點;無待重審者(同專案之對照)⇒ 不起', () => {
            let dir = mkProject('reaudit', { emptyPlan: true })
            seedState(dir, (P) => {
                let id = putExecutedIn(P, ['A01_nt'], 1)
                P.records.putDreamDoc({ round: 1, createdAt: new Date().toISOString(), agent: null, scope: { nodes: [id], reworked: [] }, audits: [{ nodeId: id, trust: 'trusted', action: 'accept', evidence: [], issues: [] }], synthesis: null, guidance: null, docsUpdated: [], harness: null })
                P.setState({ pendingReaudit: [id] })
            })
            fs.mkdirSync(path.join(dir, 'rsi', 'rounds', 'r001'), { recursive: true })
            let r = runCli(dir, ['--mode', 'round'])
            assert.equal(r.status, 0, r.out)
            assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'round-done', 'run-done'], r.out)
            assert.equal(r.events[1].round, 2)
            assert.deepEqual(r.calls.map((c) => [c.fn, c.nAudits, c.hasRequest]), [['dispatchClaude', 1, false]], '做夢審計 1 個待重審之節點;未要求 ⇒ 不標只做夢')
            //對照: 待重審名單清空後, 同一專案之下一次起跑 ⇒ 前緣為空而不起
            seedState(dir, (P) => {
                P.setState({ pendingReaudit: [] })
            })
            let r2 = runCli(dir, ['--mode', 'round'])
            assert.equal(r2.events[r2.events.length - 1].reason, 'frontier-empty', r2.out)
            //只做夢輪次遇待重審之節點 ⇒ 不受理
            seedState(dir, (P) => {
                P.setState({ pendingReaudit: [P.rsi.store.listIndex().filter((x) => x.status === 'executed')[0].id] })
            })
            let r3 = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt')])
            assert.equal(r3.events[r3.events.length - 1].reason, 'dream-only-busy', r3.out)
            assert(/待重審之節點 1 個/.test(r3.events[r3.events.length - 1].stopped))
        })

        it('補做夢之路徑(R-REC-34 之附算):輪末鉤子之附算記於該輪 ROUND.json 之 hook.fill 與 round-done 事件之 fill(與一般輪次同)', () => {
            let dir = mkProject('redreamFill', { emptyPlan: true })
            seedState(dir, (P) => {
                let id = putExecutedIn(P, ['A01_nt'], 1)
                //附算之對象: 有正本之數字與成品(本合成專案無評估入口之進入檔 ⇒ 附算之評估失敗, 仍記於 fill)
                P.rsi.store.updateNode(id, (x) => {
                    x.raw = { metrics: { selHash: 'sel-0', ext: {}, op: { eqYr: { mean: 1.5, min: -0.5, byPhase: [1, 2] }, monthlyOrders: { mean: 90 }, peakHold: { max: 20 }, winRate: 0.4 } }, issues: [] }
                    x.score = { S: 1, ladder: 0, flags: { vetoed: false, why: [] } }
                })
                let wd = path.join(dir, 'rsi', 'work', id)
                fs.mkdirSync(wd, { recursive: true })
                fs.writeFileSync(path.join(wd, 'pick.mjs'), 'export default function pick(ctx) {\n    return [0]\n}\n', 'utf8')
            })
            //第 1 輪之節點已入樹而做夢未交付(無做夢文件)⇒ 起跑時先補做夢; 該輪之 ROUND.json 已在
            fs.mkdirSync(path.join(dir, 'rsi', 'rounds', 'r001'), { recursive: true })
            fs.writeFileSync(path.join(dir, 'rsi', 'rounds', 'r001', 'ROUND.json'), JSON.stringify({ round: 1, hook: null }), 'utf8')
            let r = runCli(dir, ['--mode', 'round'])
            assert.equal(r.status, 0, `${r.out}\n${fs.readFileSync(path.join(dir, 'rsi', 'rounds', 'r001', 'ROUND.json'), 'utf8').slice(0, 1500)}`)
            let rd = r.events.find((e) => e.event === 'round-done' && e.recovered === true)
            assert(rd && rd.round === 1, JSON.stringify(r.events))
            assert(rd.fill && rd.fill.n === 1, JSON.stringify(rd))
            let R = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'rounds', 'r001', 'ROUND.json'), 'utf8'))
            assert(R.redream && R.redream.delivered === true, JSON.stringify(R.redream))
            assert.deepEqual(R.hook.fill, rd.fill)
        })

        //一般輪次之主路徑(src/cli/rsi.mjs 之輪次結束處: ROUND.json 之 hook 與 round-done 事件之寫出; 一般輪次與只做夢輪次共用同一段, 補做夢為另一處 —— 見上一案)
        //  Gitea #178 §7 第 5 點之主控裁定: 一般輪次之 round-done 事件與 ROUND.json 之 fill 欄須有子行程之案
        it('一般輪次之主路徑(--mode round --dream-only):輪末鉤子之附算記於 ROUND.json 之 hook.fill 與 round-done 事件之 fill(同值、含待重試與失敗之個數);無附算作為者兩處皆不帶 fill', () => {
            let seedExecuted = (dir) => seedState(dir, (P) => {
                let id = putExecutedIn(P, ['A01_nt'], 1)
                P.rsi.store.updateNode(id, (x) => {
                    x.raw = { metrics: { selHash: 'sel-0', ext: {}, op: { eqYr: { mean: 1.5, min: -0.5, byPhase: [1, 2] }, monthlyOrders: { mean: 90 }, peakHold: { max: 20 }, winRate: 0.4 } }, issues: [] }
                    x.score = { S: 1, ladder: 0, flags: { vetoed: false, why: [] } }
                })
                let wd = path.join(dir, 'rsi', 'work', id)
                fs.mkdirSync(wd, { recursive: true })
                fs.writeFileSync(path.join(wd, 'pick.mjs'), 'export default function pick(ctx) {\n    return [0]\n}\n', 'utf8')
                //第 1 輪已有做夢文件(不觸發補做夢)與輪夾
                P.records.putDreamDoc({ round: 1, createdAt: new Date().toISOString(), agent: null, scope: { nodes: [id], reworked: [] }, audits: [{ nodeId: id, trust: 'trusted', action: 'accept', evidence: [], issues: [] }], synthesis: null, guidance: null, docsUpdated: [], harness: null })
                fs.mkdirSync(path.join(dir, 'rsi', 'rounds', 'r001'), { recursive: true })
            })
            //有附算之作為: 來源為輪末之待重試 ⇒ 輪末鉤子對該節點附算(本合成專案無評估入口之進入檔 ⇒ 評估失敗, 仍記於 fill)
            let dir = mkProject('roundFill', { emptyPlan: true })
            seedExecuted(dir)
            let id = fs.readdirSync(path.join(dir, 'rsi', 'work'))[0]
            fs.writeFileSync(path.join(dir, 'rsi', 'fill_state.json'), JSON.stringify({ schema: 'arsi.fillState/1', evaluator: 'x', registry: null, retry: [{ id, n: 1, last: '前次之失敗', source: 'round' }] }), 'utf8')
            let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt')])
            assert.equal(r.status, 0, r.out)
            let rd = r.events.find((e) => e.event === 'round-done' && e.recovered !== true)
            assert(rd && rd.dreamOnly === true && rd.ok === true, JSON.stringify(r.events))
            let R = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'rounds', `r${String(rd.round).padStart(3, '0')}`, 'ROUND.json'), 'utf8'))
            assert(rd.fill && rd.fill.n === 1 && rd.fill.failed === 1 && rd.fill.retry === 1 && rd.fill.backlog && typeof rd.fill.sec === 'number', JSON.stringify(rd))
            assert.deepEqual(R.hook.fill, rd.fill, 'ROUND.json 之 hook.fill 與事件之 fill 同值')
            assert(R.hook.lines.some((l) => l.startsWith('附算(')), '一頁摘要之列')
            //無附算之作為(樹上無已執行之節點、無待重試)⇒ 兩處皆不帶 fill
            let dir2 = mkProject('roundNoFill', { emptyPlan: true })
            let r2 = runCli(dir2, ['--mode', 'round', '--dream-only', '--file', path.join(dir2, 'why.txt')])
            assert.equal(r2.status, 0, r2.out)
            let rd2 = r2.events.find((e) => e.event === 'round-done')
            assert(rd2 && rd2.dreamOnly === true, JSON.stringify(r2.events))
            assert.equal('fill' in rd2, false)
            let R2 = JSON.parse(fs.readFileSync(path.join(dir2, 'rsi', 'rounds', `r${String(rd2.round).padStart(3, '0')}`, 'ROUND.json'), 'utf8'))
            assert.equal('fill' in R2.hook, false)
        })
    })
})


//putExecutedIn, 於專案物件之樹上放一個已執行之節點(僅供預先寫入狀態; 不經評估)
let putExecutedIn = (P, arms, round) => {
    let spec = { arms, base: null }
    let id = P.idOf(spec)
    P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round })
    return id
}
