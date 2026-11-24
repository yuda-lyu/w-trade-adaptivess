import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { NODE_SCHEMA, DREAM_SCHEMA, IMPROVE_KINDS, DIR_VERDICTS, TASK_TYPES, EXPAND_DECISIONS, OVERVIEW_COVERAGE, OVERVIEW_PROGRESS, OVERVIEW_RISK, checkNodeAgentPart, checkDreamAgentPart, tallyDream, renderNodeMd, renderDreamMd, createFileRecords, roundName } from '../src/arsi/records.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//節點文件與做夢文件之規格、檢核、渲染與儲存(R-REC-1; 規格全文在 src/arsi/records.mjs 檔頭)
let nodePart = () => ({
    plan: { target: 't', approach: 'a', hypotheses: ['h'] },
    code: { artifact: 'w/x.mjs', files: [], reused: ['tool'], notes: 'n' },
    results: { claimed: { S: 1.5, id: 'abc' }, experiments: [{ what: 'w', outcome: 'o' }] },
    conclusion: { outcome: 'neutral', summary: 's', findings: [], limitations: [], nextIdeas: [] },
})
let dreamPart = (ids) => ({
    audits: ids.map((id) => ({ nodeId: id, trust: 'trusted', action: 'accept', evidence: ['e'], issues: [] })),
    synthesis: { summary: 's', worked: [], failed: [], patterns: [] },
    guidance: { directions: [{ arms: ['A'], base: null, rationale: 'r', expect: 'e' }], avoid: [], openQuestions: [], toolRequests: [] },
    docsUpdated: [{ file: 'f', what: 'w' }],
})

describe('records:agent 交付部分之檢核', function () {
    it('節點:合格者無問題;缺欄、型別不符、outcome 不在值域者各自被指出;舊名 code.pick 仍接受', () => {
        assert.deepEqual(checkNodeAgentPart(nodePart()), [])
        assert.deepEqual(checkNodeAgentPart('x'), ['節點文件不是 JSON 物件'])
        let cases = [
            [(a) => {
                a.plan.target = ' '
            }, /plan\.target/],
            [(a) => {
                a.plan.hypotheses = 'x'
            }, /hypotheses/],
            [(a) => {
                delete a.code.artifact
            }, /code\.artifact/],
            [(a) => {
                a.code.reused = [1]
            }, /code\.reused/],
            [(a) => {
                a.results.claimed = null
            }, /results\.claimed/],
            [(a) => {
                a.results.experiments = [{ what: 'w' }]
            }, /experiments/],
            [(a) => {
                a.conclusion.outcome = 'great'
            }, /conclusion\.outcome/],
            [(a) => {
                a.conclusion.findings = 'x'
            }, /conclusion\.findings/],
        ]
        for (let [mut, re] of cases) {
            let a = nodePart()
            mut(a)
            assert(checkNodeAgentPart(a).some((x) => re.test(x)), `應指出 ${re}`)
        }
        let legacy = nodePart()
        legacy.code = { pick: 'w/x.mjs' }
        assert.deepEqual(checkNodeAgentPart(legacy), [])
    })

    it('做夢:每個應審節點都要有審計;trust / action 須在值域;rework 須附 reworkBrief、delete 須附 deleteWhy;方向須含 arms 與 rationale', () => {
        assert.deepEqual(checkDreamAgentPart(dreamPart(['n1', 'n2']), ['n1', 'n2']), [])
        assert(checkDreamAgentPart(dreamPart(['n1']), ['n1', 'n2']).some((x) => /缺節點 n2/.test(x)))
        let cases = [
            [(a) => {
                a.audits[0].trust = 'ok'
            }, /trust/],
            [(a) => {
                a.audits[0].action = 'keep'
            }, /action/],
            [(a) => {
                a.audits[0].action = 'rework'
            }, /reworkBrief/],
            [(a) => {
                a.audits[0].action = 'delete'
            }, /deleteWhy/],
            [(a) => {
                a.audits[0].evidence = 'x'
            }, /evidence/],
            [(a) => {
                a.synthesis.summary = ''
            }, /synthesis\.summary/],
            [(a) => {
                a.guidance.directions = [{ arms: [], base: null, rationale: 'r' }]
            }, /directions/],
            [(a) => {
                a.guidance.avoid = 'x'
            }, /guidance\.avoid/],
            [(a) => {
                a.docsUpdated = [{ file: 'f' }]
            }, /docsUpdated/],
        ]
        for (let [mut, re] of cases) {
            let a = dreamPart(['n1'])
            mut(a)
            assert(checkDreamAgentPart(a, ['n1']).some((x) => re.test(x)), `應指出 ${re}`)
        }
    })

    it('做夢:改進項須分類(kind 在值域、target 與 what 非空);前次方向之回顧須含輪次、臂與判定;舊制之 toolRequests 仍接受', () => {
        //R-REC-5: 改進項依作用對象分類; 類別不在值域、缺對象或內容者各自被指出(指出第幾筆)
        let ok = dreamPart(['n1'])
        delete ok.guidance.toolRequests
        ok.guidance.improvements = IMPROVE_KINDS.map((k) => ({ kind: k, target: 't', what: 'w', evidence: 'e' }))
        ok.synthesis.prevDirections = DIR_VERDICTS.map((v, i) => ({ round: i + 1, arms: ['A'], verdict: v, note: 'n' }))
        assert.deepEqual(checkDreamAgentPart(ok, ['n1']), [])
        let empty = dreamPart(['n1'])
        empty.guidance.improvements = []
        empty.synthesis.prevDirections = []
        assert.deepEqual(checkDreamAgentPart(empty, ['n1']), [], '空陣列(沒有改進項 / 前次無方向)合格')
        let cases = [
            [(a) => {
                a.guidance.improvements = 'x'
            }, /improvements 須為陣列/],
            [(a) => {
                a.guidance.improvements = [{ kind: 'loop', target: 't', what: 'w' }, { kind: 'misc', target: 't', what: 'w' }]
            }, /improvements\[1\]\.kind/],
            [(a) => {
                a.guidance.improvements = [{ kind: 'loop | dream(擇一)', target: 't', what: 'w' }]
            }, /improvements\[0\]\.kind/],
            [(a) => {
                a.guidance.improvements = [{ kind: 'node', target: ' ', what: 'w' }]
            }, /improvements\[0\] 須為/],
            [(a) => {
                a.guidance.improvements = [{ kind: 'node', target: 't' }]
            }, /improvements\[0\] 須為/],
            [(a) => {
                a.guidance.improvements = [{ kind: 'node', target: 't', what: 'w', evidence: 1 }]
            }, /improvements\[0\] 須為/],
            [(a) => {
                a.synthesis.prevDirections = [{ round: 1, arms: ['A'], verdict: 'yes', note: 'n' }]
            }, /prevDirections/],
            [(a) => {
                a.synthesis.prevDirections = [{ round: '1', arms: ['A'], verdict: 'confirmed', note: 'n' }]
            }, /prevDirections/],
            [(a) => {
                a.synthesis.prevDirections = [{ round: 1, arms: [], verdict: 'confirmed', note: 'n' }]
            }, /prevDirections/],
            [(a) => {
                a.synthesis.prevDirections = [{ round: 1, arms: ['A'], verdict: 'confirmed' }]
            }, /prevDirections/],
        ]
        for (let [mut, re] of cases) {
            let a = dreamPart(['n1'])
            mut(a)
            assert(checkDreamAgentPart(a, ['n1']).some((x) => re.test(x)), `應指出 ${re}`)
        }
    })

    it('做夢:tallyDream 依類別計改進項、依判定計前次方向之回顧;舊制 toolRequests 與類別不在值域者計為未分類', () => {
        let a = dreamPart(['n1'])
        a.guidance.toolRequests = ['舊一', '舊二']
        a.guidance.improvements = [{ kind: 'loop', target: 't', what: 'w' }, { kind: 'loop', target: 't', what: 'w' }, { kind: 'validation', target: 't', what: 'w' }, { kind: 'misc', target: 't', what: 'w' }]
        a.synthesis.prevDirections = [{ round: 1, arms: ['A'], verdict: 'confirmed', note: 'n' }, { round: 1, arms: ['B'], verdict: 'flawed', note: 'n' }, { round: 1, arms: ['C'], verdict: 'flawed', note: 'n' }, { round: 1, arms: ['D'], verdict: '(擇一)', note: 'n' }]
        let t = tallyDream(a)
        assert.deepEqual(t.improvements, { total: 6, loop: 2, dream: 0, node: 0, tool: 0, score: 0, validation: 1, external: 0, unclassified: 3 })
        assert.deepEqual(t.prevDirections, { 'total': 3, 'confirmed': 1, 'refuted': 0, 'inconclusive': 0, 'flawed': 2, 'not-run': 0 }, '判定不在值域者不計')
        assert.deepEqual(tallyDream(null).improvements.total, 0, '未交付者為 0')
        assert.deepEqual(tallyDream(dreamPart(['n1'])).improvements, { total: 0, loop: 0, dream: 0, node: 0, tool: 0, score: 0, validation: 0, external: 0, unclassified: 0 })
    })
})

describe('records:任務類型與擴建(/3 之選配欄)', function () {
    it('節點:code.shareable 須為 [{ file, what }];省略或空陣列合格', () => {
        //R-TB-3: 節點自報可共用之輔助, 交由做夢整併
        let a = nodePart()
        a.code.shareable = [{ file: 'helper.mjs', what: '依側配席' }]
        assert.deepEqual(checkNodeAgentPart(a), [])
        a.code.shareable = []
        assert.deepEqual(checkNodeAgentPart(a), [])
        a.code.shareable = [{ file: 'helper.mjs' }]
        assert(checkNodeAgentPart(a).some((x) => /code\.shareable/.test(x)))
        a.code.shareable = 'helper.mjs'
        assert(checkNodeAgentPart(a).some((x) => /code\.shareable/.test(x)))
    })

    it('未作用之臂(R-REC-20;選配欄):節點 code.inactiveArms 與做夢 audits[].inactiveArms 須為字串陣列,省略或空陣列合格;渲染於節點文件(自報、審計所定)與做夢文件', () => {
        //指派之臂經實測後於交付版關閉者須列出, 看板之各臂成績與補位載體才不會把載體之分數算在該臂上
        let a = nodePart()
        a.code.inactiveArms = []
        assert.deepEqual(checkNodeAgentPart(a), [])
        a.code.inactiveArms = ['E39_skipWeekend']
        assert.deepEqual(checkNodeAgentPart(a), [])
        a.code.inactiveArms = 'E39_skipWeekend'
        assert(checkNodeAgentPart(a).some((x) => /code\.inactiveArms/.test(x)))
        let d = dreamPart(['n1'])
        d.audits[0].inactiveArms = ['E39_skipWeekend']
        assert.deepEqual(checkDreamAgentPart(d, ['n1']), [])
        d.audits[0].inactiveArms = [1]
        assert(checkDreamAgentPart(d, ['n1']).some((x) => /audits\[n1\]\.inactiveArms/.test(x)))
        let nd = { nodeId: 'n9', round: 1, attempt: 1, status: 'verified', spec: { arms: ['A', 'E39_skipWeekend'], base: null }, task: { goal: 'g' }, ...nodePart(), harness: { ok: true, summary: [], notes: [], score: { S: 1, ladder: 0, flags: { vetoed: false, why: [] } } } }
        assert(!renderNodeMd(nd).includes('未作用'), '未填者不列')
        nd.code.inactiveArms = ['E39_skipWeekend']
        nd.audit = { round: 1, by: 'm', trust: 'partial', action: 'accept', evidence: [], issues: [], reworkBrief: null, deleteWhy: null, inactiveArms: ['E39_skipWeekend'] }
        let md = renderNodeMd(nd)
        assert(md.includes('- 指派之臂中交付版未作用者(自報): E39_skipWeekend') && md.includes('- 未作用之臂(審計所定): E39_skipWeekend'))
        assert(renderNodeMd({ ...nd, audit: { ...nd.audit, inactiveArms: [] } }).includes('- 未作用之臂(審計所定): 無'), '審計判為皆作用中者亦列(改判了節點之自報)')
        d.audits[0].inactiveArms = ['E39_skipWeekend']
        assert(renderDreamMd({ round: 4, scope: { nodes: ['n1'] }, ...d }).includes('- 未作用之臂(指派而交付版未實現者): E39_skipWeekend'))
    })

    it('驗證類節點之結論即主張之判定:有 claimVerdict 者可省 outcome;節點文件不並列兩種判定;探索類照舊', () => {
        //驗證類節點之任務書不要求 outcome(半庫等驗證之交付版其 S 本來就低於對照): 規格須收「只有主張之判定」之結論
        let part = (c) => {
            let a = nodePart(); delete a.conclusion.outcome; a.conclusion = { ...a.conclusion, ...c }; return a
        }
        assert.deepEqual(checkNodeAgentPart(part({ claimVerdict: 'confirmed', claimNote: '四個半庫皆過' })), [])
        assert(checkNodeAgentPart(part({})).some((x) => /conclusion\.outcome/.test(x)), '無主張之判定者仍須填 outcome')
        assert(checkNodeAgentPart(part({ claimVerdict: 'confirmed', outcome: 'great' })).some((x) => /conclusion\.outcome/.test(x)), '給了 outcome 仍須在值域內')
        //節點文件: 驗證類而有主張之判定者只列主張之判定(舊文件填了 outcome 者亦不列); 探索類(含附主張之判定者)兩列皆列
        let doc = (type, c) => ({ nodeId: 'n9', round: 1, attempt: 1, status: 'verified', spec: { arms: ['A'], base: null }, task: { goal: 'g', type }, ...part(c), harness: { ok: true, summary: [], notes: [], score: { S: 1, ladder: 0, flags: { vetoed: false, why: [] } } } })
        let v = renderNodeMd(doc('verify', { claimVerdict: 'confirmed', claimNote: 'n', outcome: 'worse' }))
        assert(v.includes('主張之判定') && v.includes('成立') && !v.includes('判定(agent 自判;相對其比較對象)'), v)
        let x = renderNodeMd(doc('explore', { claimVerdict: 'refuted', claimNote: 'n', outcome: 'improved' }))
        assert(x.includes('主張之判定') && x.includes('判定(agent 自判;相對其比較對象): improved'))
        assert(renderNodeMd(doc('verify', { outcome: 'neutral' })).includes('判定(agent 自判;相對其比較對象): neutral'), '驗證類而無主張之判定者(舊文件)照列')
    })

    it('做夢:方向之 type 須在值域(省略 = 探索);verify 須附 claim', () => {
        //R-REC-8: 任務類型由做夢於方向上指定
        assert.deepEqual(TASK_TYPES, ['explore', 'verify'])
        let mk = (d) => {
            let a = dreamPart(['n1']); a.guidance.directions = [{ arms: ['A'], base: null, rationale: 'r', ...d }]; return checkDreamAgentPart(a, ['n1'])
        }
        assert.deepEqual(mk({}), [], '省略 type 合格')
        assert.deepEqual(mk({ type: 'explore' }), [])
        assert.deepEqual(mk({ type: 'verify', claim: '主張甲' }), [])
        assert(mk({ type: 'verify' }).some((x) => /verify 時須附 claim/.test(x)))
        assert(mk({ type: 'verify', claim: ' ' }).some((x) => /verify 時須附 claim/.test(x)))
        assert(mk({ type: 'explore | verify(擇一)' }).some((x) => /type 須為 explore \/ verify/.test(x)), '範本之佔位字未改者被指出')
    })

    it('做夢:expansion 之每項須有 item 與值域內之 decision;built / updated 須附 files 與 verify;tallyDream 依處置計數', () => {
        //R-TB-2: 擴建項之處置 built / updated / declined / core
        assert.deepEqual(EXPAND_DECISIONS, ['built', 'updated', 'declined', 'core'])
        let mk = (ex) => {
            let a = dreamPart(['n1']); a.expansion = ex; return checkDreamAgentPart(a, ['n1'])
        }
        assert.deepEqual(mk([]), [])
        assert.deepEqual(mk([{ item: '甲', sources: ['n1'], decision: 'built', files: ['t/a.mjs'], verify: '跑過' }, { item: '乙', decision: 'declined', note: '太瑣碎' }, { item: '丙', decision: 'core' }]), [])
        let cases = [
            ['x', /expansion 須為陣列/],
            [[{ item: '甲', decision: 'done' }], /expansion\[0\]\.decision/],
            [[{ item: ' ', decision: 'declined' }], /expansion\[0\] 須為/],
            [[{ item: '甲', decision: 'declined', sources: 'n1' }], /expansion\[0\] 須為/],
            [[{ item: '甲', decision: 'built', verify: '跑過' }], /built 時須附 files/],
            [[{ item: '甲', decision: 'updated', files: ['t/a.mjs'] }], /updated 時須附 files/],
        ]
        for (let [ex, re] of cases) {
            assert(mk(ex).some((x) => re.test(x)), `應指出 ${re}`)
        }
        let a = dreamPart(['n1'])
        a.expansion = [{ item: '甲', decision: 'built' }, { item: '乙', decision: 'built' }, { item: '丙', decision: 'core' }, { item: '丁', decision: '?' }]
        assert.deepEqual(tallyDream(a).expansion, { total: 4, built: 2, updated: 0, declined: 0, core: 1 }, '處置不在值域者只計入總數')
        assert.deepEqual(tallyDream(dreamPart(['n1'])).expansion, { total: 0, built: 0, updated: 0, declined: 0, core: 0 })
    })

    it('做夢:整體研判(synthesis.overview;選配)—— 三個判定須在值域內並附非空之依據,可填 unknown;tallyDream 取三個判定;渲染於彙整之首', () => {
        //規則 R-REC-14: 做夢除審計本輪之節點外, 另就當前與過往之整體搜尋下判斷(集中度、進度、局部最佳點之風險), 供下一輪之節點與日後之做夢參考
        assert.deepEqual([OVERVIEW_COVERAGE, OVERVIEW_PROGRESS, OVERVIEW_RISK], [['concentrated', 'balanced', 'scattered', 'unknown'], ['advancing', 'flat', 'regressing', 'unknown'], ['low', 'medium', 'high', 'unknown']])
        let good = { families: [{ name: '近期損益之反轉', nodes: ['n1', 'n2'], basis: '皆依近窗每單均益升冪' }], coverage: { verdict: 'concentrated', why: '8 / 10 個節點含 B 層' }, progress: { verdict: 'advancing', why: '15.4 → 21.3' }, localOptimum: { risk: 'unknown', why: '節點太少' }, blindSpots: ['G 層未試'], adjust: '向外至少一半', prevReview: '' }
        let mk = (ov) => {
            let a = dreamPart(['n1']); a.synthesis.overview = ov; return checkDreamAgentPart(a, ['n1'])
        }
        assert.deepEqual(mk(good), [])
        assert.deepEqual(checkDreamAgentPart(dreamPart(['n1']), ['n1']), [], '未給此欄者合格(選配;是否必填由專案於輪末摘要標示)')
        let cases = [
            ['x', /synthesis\.overview 須為物件/],
            [{ ...good, coverage: { verdict: 'narrow', why: 'w' } }, /overview\.coverage/],
            [{ ...good, progress: { verdict: 'advancing', why: ' ' } }, /overview\.progress/],
            [{ ...good, localOptimum: { verdict: 'high', why: 'w' } }, /overview\.localOptimum/],
            [{ ...good, blindSpots: 'G' }, /overview\.blindSpots/],
            [{ ...good, adjust: 3 }, /overview\.adjust/],
            [{ ...good, families: [{ name: '甲', nodes: 'n1', basis: 'b' }] }, /overview\.families/],
        ]
        for (let [ov, re] of cases) {
            assert(mk(ov).some((x) => re.test(x)), `應指出 ${re}`)
        }
        let a = dreamPart(['n1'])
        a.synthesis.overview = good
        assert.deepEqual(tallyDream(a).overview, { coverage: 'concentrated', progress: 'advancing', localOptimum: 'unknown', nFamilies: 1, outwardChecked: 0 })
        assert.strictEqual(tallyDream(dreamPart(['n1'])).overview, null)
        //outwardChecked(選配; 規則 R-REC-26): 本輪已預先核對而皆無內容之向外候選 { kinds: 正整數, files: [檔名…](至少 1 個) }; tallyDream 取其種數; 渲染於「據此之調整」之後
        assert.deepEqual(mk({ ...good, outwardChecked: { kinds: 4, files: ['fp_a.mjs', 'ab_b.mjs'] } }), [])
        assert.deepEqual(mk({ ...good, outwardChecked: null }), [], 'null 視同未給')
        for (let oc of [{ kinds: 0, files: ['a.mjs'] }, { kinds: 3, files: [] }, { kinds: 2.5, files: ['a.mjs'] }, { kinds: 3 }, 3]) {
            assert(mk({ ...good, outwardChecked: oc }).some((x) => /overview\.outwardChecked/.test(x)), `應指出 outwardChecked 不合: ${JSON.stringify(oc)}`)
        }
        let ao = dreamPart(['n1'])
        ao.synthesis.overview = { ...good, outwardChecked: { kinds: 4, files: ['fp_a.mjs', 'ab_b.mjs'] } }
        assert.equal(tallyDream(ao).overview.outwardChecked, 4)
        assert(renderDreamMd({ round: 4, scope: { nodes: ['n1'] }, ...ao }).includes('- 已預先核對而皆無內容之向外候選:4 種(`fp_a.mjs`、`ab_b.mjs`)'))
        //方向之 newFamily(選配; 布林): 此方向是否押新的機制家族; 渲染時標〔換家族〕
        a.guidance.directions = [{ type: 'explore', newFamily: true, arms: ['C'], base: null, rationale: 'r' }, { type: 'verify', newFamily: false, arms: ['A'], base: 'n1', claim: 'c', rationale: 'r' }]
        assert.deepEqual(checkDreamAgentPart(a, ['n1']), [])
        let bad = dreamPart(['n1'])
        bad.guidance.directions = [{ arms: ['C'], base: null, rationale: 'r', newFamily: 'yes' }]
        assert(checkDreamAgentPart(bad, ['n1']).some((x) => /newFamily 須為布林值/.test(x)))
        let dm = renderDreamMd({ round: 4, scope: { nodes: ['n1'] }, ...a })
        assert(dm.includes('1. 〔探索〕〔換家族〕臂 C;起點 無') && dm.includes('2. 〔驗證〕臂 A;起點 n1') && dm.includes('- **近期損益之反轉**:`n1`、`n2` —— 皆依近窗每單均益升冪'))
        assert(dm.includes('### 整體研判') && dm.includes('- 搜尋之集中度:**過於集中** —— 8 / 10 個節點含 B 層') && dm.includes('- 卡在局部最佳點之風險:**樣本不足以判定** —— 節點太少') && dm.includes('  - G 層未試') && dm.includes('- 據此之調整:向外至少一半'))
        assert(dm.indexOf('### 整體研判') > dm.indexOf('## 2. 彙整') && dm.indexOf('### 整體研判') < dm.indexOf('- 有效:'))
        assert(!renderDreamMd({ round: 4, scope: { nodes: ['n1'] }, ...dreamPart(['n1']) }).includes('整體研判'), '無此欄之文件不列')
    })

    it('渲染:節點文件列任務類型、待驗之主張與自報可共用;做夢文件之方向帶類型、擴建一節在專案文件之更新之前', () => {
        let nd = { nodeId: 'n9', round: 1, attempt: 1, status: 'verified', spec: { arms: ['A'], base: null }, task: { goal: 'g', type: 'verify', claim: '主張甲' }, ...nodePart(), harness: { ok: true, summary: [], notes: [], score: { S: 1, ladder: 0, flags: { vetoed: false, why: [] } } } }
        nd.code.shareable = [{ file: 'helper.mjs', what: '依側配席' }]
        let md = renderNodeMd(nd)
        assert(md.includes('任務類型: **驗證**(verify);待驗之主張: 主張甲'))
        assert(md.includes('- 自報可共用之輔助(由做夢整併): helper.mjs(依側配席)'))
        assert(!renderNodeMd({ ...nd, task: { goal: 'g' } }).includes('任務類型'), '舊文件(無 type)不列')
        let a = dreamPart(['n1'])
        a.guidance.directions = [{ type: 'verify', arms: ['A'], base: 'n1', claim: '主張甲', rationale: 'r', expect: 'e' }, { type: 'explore', arms: ['B'], base: null, rationale: 'r2' }]
        a.expansion = [{ item: '依側配席', sources: ['n1', 'n2'], decision: 'built', files: ['t/snippets/seat.mjs'], verify: 'selHash 不變' }, { item: '乙', decision: 'declined', note: '只有一個節點用得到' }]
        let dm = renderDreamMd({ round: 4, scope: { nodes: ['n1'] }, ...a, harness: { docIssues: [], toolbox: { ok: true, changed: { added: ['snippets/seat.mjs'], changed: ['README.md'], removed: [] }, reverted: [], issues: [] } } })
        assert(dm.includes('1. 〔驗證〕臂 A;起點 n1;待驗之主張: 主張甲 —— r(預期: e)'))
        assert(dm.includes('2. 〔探索〕臂 B;起點 無 —— r2'))
        assert(dm.includes('- 〔新增〕依側配席(出處:n1、n2);檔:t/snippets/seat.mjs;驗證:selHash 不變'))
        assert(dm.includes('- 〔不納入〕乙;只有一個節點用得到'))
        assert(dm.includes('迴圈之機械檢查:通過;新增 1 檔、修改 1 檔'))
        assert(dm.indexOf('## 4. 擴建') > 0 && dm.indexOf('## 4. 擴建') < dm.indexOf('## 5. 專案文件之更新') && dm.includes('## 6. 迴圈之執行結果'))
        a.expansion = []
        assert(renderDreamMd({ round: 4, scope: { nodes: ['n1'] }, ...a }).includes('## 4. 擴建(共用工具;由做夢統籌)\n\n(無)'))
    })
})

describe('records:渲染與檔案儲存', function () {
    let t
    let rec
    before(() => {
        t = makeTmp('records')
        rec = createFileRecords({ nodeDir: path.join(t.dir, 'nodes'), dreamDir: path.join(t.dir, 'dreams'), trashDir: path.join(t.dir, 'trash') })
    })
    after(() => {
        t.cleanup()
    })

    it('節點文件:JSON 為正本並帶規格代號;Markdown 由正本渲染 —— 自報與迴圈重跑並列、專案之補充列、獨立驗證之旗標、檢查', () => {
        let doc = rec.putNodeDoc({
            nodeId: 'n1',
            round: 2,
            attempt: 1,
            status: 'verified',
            spec: { arms: ['A'], base: null },
            task: { goal: 'g', refs: [{ file: 'r.md', why: 'w' }], rework: null },
            agent: { kind: 'k', model: 'm', startedAt: 'a', endedAt: 'b', durationSec: 3, ok: true },
            ...nodePart(),
            harness: { ok: true, summary: [{ key: 'S', label: '分數', value: 1.5 }, { key: 'id', label: '指紋', value: 'abc' }], notes: ['補充一', '補充二'], score: { S: 1.5, ladder: 3, flags: { vetoed: true, why: ['旗標 fail'] } }, fingerprint: 'abc', checks: { issues: ['問題甲'], nEvals: 9 }, validation: { name: 'backtest', flag: 'fail', at: 'x', error: null }, raw: { any: 1 }, evalJson: 'e.json', error: null },
            audit: null,
            history: [],
        })
        assert.equal(doc.schema, NODE_SCHEMA)
        assert.deepEqual(rec.getNodeDoc('n1').harness.summary[0], { key: 'S', label: '分數', value: 1.5 })
        let md = fs.readFileSync(rec.paths.nodeMd('n1'), 'utf8')
        //R-REC-1: Markdown 由正本渲染; 對照表逐項列「agent 自報 | 迴圈重跑(正本)」
        assert.match(md, /\| 分數 \| 1\.5 \| 1\.5 \|/)
        assert.match(md, /\| 指紋 \| abc \| abc \|/)
        assert.match(md, /階梯 3;否決;旗標 fail/)
        assert.match(md, /- 補充一\n- 補充二/)
        assert.match(md, /獨立驗證\(backtest\): fail/)
        assert.match(md, /迴圈檢查: 問題甲;agent 於本次交付前共執行評估 9 次/)
        assert.match(md, /成品: w\/x\.mjs/)
        assert.match(md, /尚未審計/)
        assert.equal(md, renderNodeMd(rec.getNodeDoc('n1')), '同一正本渲染結果相同')
    })

    it('節點文件:自報有而迴圈 summary 無之鍵仍列出;審計寫回後渲染可信度與處置', () => {
        let d = rec.getNodeDoc('n1')
        d.results.claimed.extra = 7
        d.audit = { round: 2, by: 'm', trust: 'partial', action: 'rework', evidence: ['證據'], issues: ['問題'], reworkBrief: '請重做', deleteWhy: null }
        rec.putNodeDoc(d)
        let md = fs.readFileSync(rec.paths.nodeMd('n1'), 'utf8')
        assert.match(md, /\| extra \| 7 \| — \|/)
        assert.match(md, /可信度 \*\*partial\*\*;處置 \*\*rework\*\*/)
        assert.match(md, /重做要求: 請重做/)
    })

    it('做夢文件:規格代號、審計表、方向;迴圈註記置於正文之前', () => {
        let d = rec.putDreamDoc({ round: 2, agent: { kind: 'k', model: 'm', effort: 'e', startedAt: 'a', endedAt: 'b', durationSec: 1 }, scope: { nodes: ['n1'], reworked: [] }, ...dreamPart(['n1']), harness: { docIssues: [] } })
        assert.equal(d.schema, DREAM_SCHEMA)
        let md = fs.readFileSync(rec.paths.dreamMd(2), 'utf8')
        assert.match(md, /# 做夢文件 r002/)
        assert.match(md, /\| n1 \| trusted \| accept \| 0 \|/)
        assert(md.includes('1. 臂 A;起點 無 —— r(預期: e)'), '方向一列: 臂、起點、依據與預期')
        assert(!/迴圈註記/.test(md))
        d.harness.addendum = [{ at: '2026-01-02T00:00:00Z', text: '更正甲' }]
        rec.putDreamDoc(d)
        let md2 = fs.readFileSync(rec.paths.dreamMd(2), 'utf8')
        assert(md2.indexOf('迴圈註記') > 0 && md2.indexOf('迴圈註記') < md2.indexOf('## 1. 節點審計'), '註記在正文之前')
        assert.match(md2, /\(2026-01-02\)更正甲/)
        assert.equal(md2, renderDreamMd(rec.getDreamDoc(2)))
        assert.deepEqual(rec.listDreamDocs().map((x) => x.round), [2])
        assert.equal(roundName(2), 'r002')
    })

    it('做夢文件:改進項依類別渲染(類別名、對象、內容、依據);前次方向之回顧列於彙整;舊制文件(只有 toolRequests)照舊渲染', () => {
        //舊制(/1): 無 improvements ⇒ 「未分類」一節照列 toolRequests
        let old = dreamPart(['n1'])
        old.guidance.toolRequests = ['舊需求甲']
        let mdOld = renderDreamMd({ round: 3, scope: { nodes: ['n1'] }, ...old })
        assert(mdOld.includes('- 工具 / 評估器之需求(未分類):\n- 舊需求甲'))
        assert(!mdOld.includes('改進項(原則性'))
        assert(!mdOld.includes('前次方向之回顧'))
        //新制(/2)
        let a = dreamPart(['n1'])
        delete a.guidance.toolRequests
        a.guidance.improvements = [{ kind: 'loop', target: '操作掃描', what: '加檢查甲', evidence: 'n1 之紀錄' }, { kind: 'validation', target: '驗證之參照', what: '另匹配乙' }]
        a.synthesis.prevDirections = [{ round: 2, arms: ['A', 'B'], verdict: 'flawed', note: '變換單調' }, { round: 2, arms: ['C'], verdict: 'not-run', note: '未排入' }]
        let md = renderDreamMd({ round: 3, scope: { nodes: ['n1'] }, ...a })
        assert(md.includes('  - 〔迴圈架構〕操作掃描:加檢查甲(依據:n1 之紀錄)'))
        assert(md.includes('  - 〔獨立驗證判準〕驗證之參照:另匹配乙'), '無依據者不帶括號')
        assert(!md.includes('未分類'), '新制且無 toolRequests 者不列未分類一節')
        assert(md.includes('  - r002 臂 A + B:**方向本身有錯** —— 變換單調'))
        assert(md.includes('  - r002 臂 C:**尚未執行** —— 未排入'))
        assert(md.indexOf('前次方向之回顧') < md.indexOf('## 3. 給下一輪之方向'), '回顧屬彙整一節')
        //沒有改進項 ⇒ 明列(無)
        a.guidance.improvements = []
        assert(renderDreamMd({ round: 3, scope: { nodes: ['n1'] }, ...a }).includes('- 改進項(原則性 / 結構性 / 共用;依類別):\n  - (無)'))
    })

    it('刪除節點文件:正本與渲染檔移入 trash 並留理由;原處不再有', () => {
        let moved = rec.removeNodeDoc('n1', '偏差太大')
        assert.equal(moved.length, 2)
        assert.strictEqual(rec.getNodeDoc('n1'), null)
        assert.deepEqual(rec.listNodeDocs(), [])
        let files = fs.readdirSync(path.join(t.dir, 'trash'))
        assert.equal(files.length, 3)
        assert.equal(fs.readFileSync(path.join(t.dir, 'trash', files.find((f) => f.endsWith('.why.txt'))), 'utf8'), '偏差太大')
    })
})
