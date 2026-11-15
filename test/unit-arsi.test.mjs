import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createArsi } from '../src/arsi/arsi.mjs'
import { createFileRecords } from '../src/arsi/records.mjs'
import { createToolbox } from '../src/arsi/toolbox.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//代理式節點與做夢之通用流程(src/arsi/arsi.mjs 檔頭之契約; R-REC-2、R-REC-3): 派工、驗證、任務書皆以假件注入
let part = (claimed) => ({
    plan: { target: 't', approach: 'a' },
    code: { artifact: 'x.mjs' },
    results: { claimed, experiments: [] },
    conclusion: { outcome: 'neutral', summary: 's' },
})

let setup = (t, o = {}) => {
    let records = createFileRecords({ nodeDir: path.join(t.dir, 'nodes'), dreamDir: path.join(t.dir, 'dreams'), trashDir: path.join(t.dir, 'trash') })
    let calls = { dispatch: [], verify: [], hooks: [] }
    let arsi = createArsi({
        records,
        workDir: path.join(t.dir, 'work'),
        artifactFiles: ['x.mjs'],
        dispatch: async (role, a) => {
            calls.dispatch.push({ role, tag: a.tag })
            let wd = path.dirname(a.logFile)
            if (role === 'node') {
                fs.writeFileSync(path.join(wd, 'x.mjs'), `v${calls.dispatch.length}`)
                fs.writeFileSync(path.join(wd, 'extra.txt'), 'e')
                if (o.nodeJson !== null) {
                    fs.writeFileSync(path.join(wd, 'node.json'), JSON.stringify(o.nodeJson || part({ S: 10, fp: 'abc' })))
                }
            }
            else if (o.dreamJson) {
                fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(o.dreamJson))
            }
            return o.dispatchResult || { ok: true, agent: { kind: 'fake', model: `fake-${role}` } }
        },
        verify: async (a) => {
            calls.verify.push(a)
            return o.verify ? o.verify(a) : { ok: true, raw: { payload: 1 }, score: { S: 10, ladder: 1, flags: { vetoed: false, why: [] } }, summary: [{ key: 'S', label: '分數', value: 10 }, { key: 'fp', label: '指紋', value: 'abc' }], notes: ['n'], fingerprint: 'abc', issues: [], checks: { nEvals: 3 }, validation: { name: 'v', flag: 'pass', at: 'x', error: null }, evalJson: 'e.json' }
        },
        texts: { nodeBrief: (c) => `brief ${c.nodeId} a${c.attempt}${c.rework ? ` rework:${c.rework}` : ''}`, nodePrompt: () => 'p', nodeTemplate: () => ({ t: 1 }), dreamBrief: (c) => `dream ${c.round}`, dreamPrompt: () => 'p', dreamTemplate: () => ({ t: 1 }) },
        hooks: { onNodeDone: (d) => calls.hooks.push(`node:${d.nodeId}`), onDreamDone: (d) => calls.hooks.push(`dream:${d.round}`), onRoundEnd: (c) => calls.hooks.push(`end:${c.round}`) },
    })
    return { records, arsi, calls }
}

describe('arsi:節點(派工 → 迴圈重跑 → 節點文件)', function () {
    let t
    beforeEach(() => {
        t = makeTmp('arsi')
    })
    afterEach(() => {
        t.cleanup()
    })

    it('正常交付:寫任務書與範本、派工、以 verify 之結果為正本;節點文件含 summary / notes / 指紋 / 檢查 / 獨立驗證;raw = 專案之 raw + 通用欄', async () => {
        let { arsi, records, calls } = setup(t)
        let { doc, raw } = await arsi.runNode({ nodeId: 'n1', spec: { arms: ['A'] }, round: 1, task: { goal: 'g' } })
        assert(fs.existsSync(path.join(t.dir, 'work', 'n1', 'brief.md')) && fs.existsSync(path.join(t.dir, 'work', 'n1', 'node.template.json')))
        assert.deepEqual(calls.dispatch, [{ role: 'node', tag: 'r001_n1_a1' }])
        assert.equal(calls.verify[0].attempt, 1)
        assert.deepEqual([doc.status, doc.attempt, doc.harness.ok, doc.harness.fingerprint], ['verified', 1, true, 'abc'])
        assert.deepEqual(doc.harness.checks, { issues: [], nEvals: 3 })
        assert.deepEqual(doc.harness.validation, { name: 'v', flag: 'pass', at: 'x', error: null })
        assert.deepEqual(doc.harness.raw, { payload: 1 })
        assert.equal(doc.agent.model, 'fake-node')
        //契約: 入樹之 raw = 專案之完整結果 + 第幾次交付、agent、文件是否合格、問題、自報、獨立驗證之旗標
        assert.deepEqual([raw.payload, raw.attempt, raw.docOk, raw.issues.length], [1, 1, true, 0])
        assert.deepEqual(raw.validation, { name: 'v', flag: 'pass' })
        assert.deepEqual(raw.claimed, { S: 10, fp: 'abc' })
        assert.deepEqual(calls.hooks, ['node:n1'])
        assert.equal(records.getNodeDoc('n1').schema, 'arsi.node/3')
    })

    it('自報與正本不符(數字超出容差、指紋不同)、文件不合格、未自報 ⇒ 各列為問題(不判失敗)', async () => {
        let a = setup(t, { nodeJson: part({ S: 10.2, fp: 'zzz' }) })
        let r1 = await a.arsi.runNode({ nodeId: 'n1', spec: {}, round: 1, task: {} })
        //R-REC-2: 自報與正本逐項比對(summary 同鍵); 數字容差預設 max(0.05, |值| × 1e-4)
        assert(r1.raw.issues.some((x) => /自報 分數 10\.2 與重跑 10 不符/.test(x)))
        assert(r1.raw.issues.some((x) => /自報 指紋 zzz 與重跑 abc 不符/.test(x)))
        let b = setup(t, { nodeJson: part({ S: 10.04, fp: 'abc' }) })
        assert.deepEqual((await b.arsi.runNode({ nodeId: 'n2', spec: {}, round: 1, task: {} })).raw.issues, [], '容差內不列')
        let c = setup(t, { nodeJson: { plan: {} } })
        let r3 = await c.arsi.runNode({ nodeId: 'n3', spec: {}, round: 1, task: {} })
        assert.equal(r3.raw.docOk, false)
        assert(r3.raw.issues.some((x) => /^文件: /.test(x)) && r3.raw.issues.some((x) => /未自報最終結果/.test(x)))
        let d = setup(t, { nodeJson: null })
        let r4 = await d.arsi.runNode({ nodeId: 'n4', spec: {}, round: 1, task: {} })
        assert(r4.raw.issues.some((x) => /未交付 node\.json/.test(x)))
    })

    it('額度用盡而未完成(派工結果 quota: true)⇒ 不重跑驗證、不把工作夾內之半成品當成交付;節點文件記 failed、呼叫 onNodeDone、拋錯(錯誤物件帶 quota 與 doc)', async () => {
        //R-RUN-8(Gitea #156): 替身之派工照樣在工作夾留下成品檔與文件(= 半成品), 但回 quota: true ⇒ verify 不得被呼叫
        let { arsi, records, calls } = setup(t, { dispatchResult: { ok: false, quota: true, error: 'm: 額度用盡', agent: { kind: 'fake', model: 'fake-node' } } })
        await assert.rejects(() => arsi.runNode({ nodeId: 'n1', spec: { arms: ['A'] }, round: 1, task: {} }), (e) => /額度用盡而未完成/.test(e.message) && e.quota === true && e.doc.status === 'failed' && e.doc.nodeId === 'n1')
        assert.equal(calls.verify.length, 0, '不重跑驗證')
        let d = records.getNodeDoc('n1')
        assert.deepEqual([d.status, d.attempt, d.harness.ok, d.agent.ok, d.results, d.conclusion, d.plan, d.code], ['failed', 1, false, false, null, null, null, null])
        assert(/額度用盡/.test(d.harness.error) && /額度用盡/.test(d.agent.error), '節點文件寫明因額度而未完成')
        assert.equal(d.harness.score, null)
        assert.deepEqual(calls.hooks, ['node:n1'], 'onNodeDone 照常呼叫')
        //其他原因之派工失敗(無 quota)⇒ 既有行為: 照常重跑驗證(逾時之半成品亦由驗證判定)
        let b = setup(t, { dispatchResult: { ok: false, error: 'timeout TIMEOUT after 7200s', agent: { kind: 'fake', model: 'fake-node' } } })
        let r2 = await b.arsi.runNode({ nodeId: 'n2', spec: {}, round: 1, task: {} })
        assert.deepEqual([b.calls.verify.length, r2.doc.status, r2.doc.agent.ok], [1, 'verified', false])
        //quota 不為 true(缺、false)者一律不算
        for (let q of [undefined, false, 'true', 1]) {
            let c = setup(t, { dispatchResult: { ok: false, ...(q === undefined ? {} : { quota: q }), error: 'x', agent: { kind: 'fake', model: 'fake-node' } } })
            await c.arsi.runNode({ nodeId: 'n3', spec: {}, round: 1, task: {} })
            assert.equal(c.calls.verify.length, 1, `quota = ${String(q)}`)
        }
    })

    it('重做之派工因額度而未完成 ⇒ 節點文件之次數加一並留歷史、記 failed;不動前次已移入 attempt 夾之交付物', async () => {
        let a = setup(t)
        await a.arsi.runNode({ nodeId: 'n1', spec: {}, round: 1, task: {} })
        let d1 = a.records.getNodeDoc('n1')
        d1.audit = { round: 1, trust: 'partial', action: 'rework' }
        a.records.putNodeDoc(d1)
        //同一份紀錄與工作夾上, 改以回 quota 之派工器重做
        let arsi2 = createArsi({
            records: a.records,
            workDir: path.join(t.dir, 'work'),
            artifactFiles: ['x.mjs'],
            dispatch: async () => ({ ok: false, quota: true, error: '額度', agent: { kind: 'fake', model: 'fake-node' } }),
            verify: async () => {
                throw new Error('不得呼叫')
            },
            texts: { nodeBrief: () => 'b', nodePrompt: () => 'p', nodeTemplate: () => ({ t: 1 }), dreamBrief: () => 'd', dreamPrompt: () => 'p', dreamTemplate: () => ({ t: 1 }) },
            hooks: {},
        })
        await assert.rejects(() => arsi2.runNode({ nodeId: 'n1', spec: {}, round: 1, task: {}, rework: '請補對照' }), (e) => e.quota === true && e.doc.attempt === 2)
        let d = a.records.getNodeDoc('n1')
        assert.deepEqual([d.status, d.attempt, d.history.length, d.history[0].attempt], ['failed', 2, 1, 1])
        assert(fs.existsSync(path.join(t.dir, 'work', 'n1', 'attempt1', 'x.mjs')), '前次之成品檔留在 attempt1')
    })

    it('成品無法評估 ⇒ 節點文件記 failed 並拋錯(錯誤物件附文件)', async () => {
        let { arsi, records } = setup(t, { verify: async () => ({ ok: false, error: '重跑失敗', issues: [] }) })
        await assert.rejects(() => arsi.runNode({ nodeId: 'n1', spec: {}, round: 1, task: {} }), (e) => /未交付可評估之成品/.test(e.message) && e.doc.status === 'failed')
        assert.equal(records.getNodeDoc('n1').harness.ok, false)
    })

    it('重做:前次交付物移入 attempt1(成品檔留副本)、任務書帶重做要求、文件之次數加一並留歷史', async () => {
        let { arsi, records } = setup(t)
        await arsi.runNode({ nodeId: 'n1', spec: {}, round: 1, task: {} })
        let d1 = records.getNodeDoc('n1')
        d1.audit = { round: 1, trust: 'partial', action: 'rework' }
        records.putNodeDoc(d1)
        let { doc } = await arsi.runNode({ nodeId: 'n1', spec: {}, round: 1, task: {}, rework: '請補對照' })
        let wd = path.join(t.dir, 'work', 'n1')
        assert.equal(doc.attempt, 2)
        //契約: 重做時前次之交付物移入 attempt{n}; 成品檔(artifactFiles)留一份副本於工作夾給 agent 當起點
        assert.deepEqual(fs.readdirSync(path.join(wd, 'attempt1')).sort(), ['brief.md', 'extra.txt', 'node.json', 'node.template.json', 'x.mjs'])
        assert.equal(fs.readFileSync(path.join(wd, 'attempt1', 'x.mjs'), 'utf8'), 'v1', '前次之成品留存')
        assert.equal(fs.readFileSync(path.join(wd, 'x.mjs'), 'utf8'), 'v2', '工作夾內為重做後之成品')
        assert.match(fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'), /a2 rework:請補對照/)
        assert.equal(doc.task.rework, '請補對照')
        assert.equal(doc.audit, null, '重做後待再審')
        assert.deepEqual(doc.history.map((h) => [h.attempt, h.S, h.fingerprint, h.audit.action]), [[1, 10, 'abc', 'rework']])
    })

    it('task.prepare(選配;不可列舉之函數):於封存之後、寫任務書之前呼叫 —— 重做時專案得以把任務書所指之輔助檔補回工作夾;拋錯不中斷派工;不入節點文件', async () => {
        //規則 R-REC-13: 起點與參考成品之複本(base_pick.mjs、ref_<id>.mjs)在重做時會隨前次之檔移入 attempt{n}, 須由專案補回
        let { arsi, records } = setup(t)
        let wd = path.join(t.dir, 'work', 'n9')
        let mk = (throws = false) => {
            let task = {}
            Object.defineProperty(task, 'prepare', {
                enumerable: false,
                value: (dir) => {
                    fs.writeFileSync(path.join(dir, 'ref_x.mjs'), 'ref', 'utf8'); if (throws) {
                        throw new Error('boom')
                    }
                }
            })
            return task
        }
        await arsi.runNode({ nodeId: 'n9', spec: {}, round: 1, task: mk() })
        assert(fs.existsSync(path.join(wd, 'ref_x.mjs')))
        let { doc } = await arsi.runNode({ nodeId: 'n9', spec: {}, round: 1, task: mk(true), rework: '重做' })
        assert.equal(doc.attempt, 2)
        assert(fs.existsSync(path.join(wd, 'attempt1', 'ref_x.mjs')), '前次之複本隨封存移入 attempt1')
        assert(fs.existsSync(path.join(wd, 'ref_x.mjs')), '封存後由 prepare 補回')
        assert(!('prepare' in JSON.parse(JSON.stringify(records.getNodeDoc('n9').task || {}))))
    })
})

describe('arsi:做夢(審計 → 處置)', function () {
    let t
    beforeEach(() => {
        t = makeTmp('arsiDream')
    })
    afterEach(() => {
        t.cleanup()
    })

    let dream = (audits, directions = []) => ({ audits, synthesis: { summary: 's' }, guidance: { directions }, docsUpdated: [] })

    it('runDream:寫任務書、派工、檢核交付;未交付者 ok 為 false', async () => {
        let a = setup(t, { dreamJson: dream([{ nodeId: 'n1', trust: 'trusted', action: 'accept', evidence: [], issues: [] }]) })
        let r = await a.arsi.runDream({ round: 3, nodeIds: ['n1'] })
        assert.deepEqual([r.ok, r.issues.length, r.doc.round, r.doc.agent.model], [true, 0, 3, 'fake-dream'])
        assert.equal(fs.readFileSync(path.join(t.dir, 'work', 'dream_r003', 'brief.md'), 'utf8'), 'dream 3')
        let b = setup(t)
        let r2 = await b.arsi.runDream({ round: 4, nodeIds: ['n1'] })
        assert.equal(r2.ok, false)
        assert(r2.issues.some((x) => /未交付 dream\.json/.test(x)))
    })

    it('applyDream:審計寫回節點文件;accept / rework / delete 與方向各呼叫注入之處置;範圍外者略過', async () => {
        let a = setup(t, {
            dreamJson: dream([
                { nodeId: 'n1', trust: 'trusted', action: 'accept', evidence: ['e'], issues: [] },
                { nodeId: 'n2', trust: 'partial', action: 'rework', evidence: [], issues: ['i'], reworkBrief: 'rb' },
                { nodeId: 'n3', trust: 'untrusted', action: 'delete', evidence: [], issues: [], deleteWhy: 'dw' },
                { nodeId: 'zz', trust: 'trusted', action: 'accept', evidence: [], issues: [] },
            ], [{ arms: ['A'], base: null, rationale: 'r' }])
        })
        for (let id of ['n1', 'n2', 'n3']) {
            await a.arsi.runNode({ nodeId: id, spec: {}, round: 1, task: {} })
        }
        let { doc } = await a.arsi.runDream({ round: 1, nodeIds: ['n1', 'n2', 'n3'] })
        let seen = []
        let { applied } = await a.arsi.applyDream({
            doc,
            actions: {
                accept: async (id, au) => {
                    seen.push(`accept:${id}:${au.trust}`)
                },
                rework: async (id, au) => {
                    seen.push(`rework:${id}:${au.reworkBrief}`); return { ok: true }
                },
                remove: async (id, au) => {
                    seen.push(`remove:${id}:${au.deleteWhy}`); return { ok: true }
                },
                propose: async (d) => {
                    seen.push(`propose:${d.arms.join('+')}`); return { ok: true, note: 'in' }
                },
            },
        })
        //§3 審計與處置: rework 先記審計結果再重派; delete 交由注入之 remove; 方向交由 propose
        assert.deepEqual(seen, ['accept:n1:trusted', 'accept:n2:partial', 'rework:n2:rb', 'remove:n3:dw', 'propose:A'])
        assert.deepEqual([applied.accepted, applied.rework.map((x) => x.nodeId), applied.deleted.map((x) => x.nodeId), applied.proposals.length, applied.skipped.map((x) => x.nodeId)], [['n1'], ['n2'], ['n3'], 1, ['zz']])
        assert.deepEqual([a.records.getNodeDoc('n1').audit.trust, a.records.getNodeDoc('n2').audit.reworkBrief], ['trusted', 'rb'])
        assert.deepEqual(a.records.getDreamDoc(1).harness.applied.accepted, ['n1'])
        assert(a.calls.hooks.includes('dream:1'))
        await a.arsi.roundEnd({ round: 1 })
        assert(a.calls.hooks.includes('end:1'))
    })

    it('runDream + 共用工具區:做夢前留快照、做夢後逐檔檢查;不合之檔還原、合格者留下;與 expansion 對照(未記入者、列了而不存在者各列為問題);結果記入做夢文件', async () => {
        //R-TB-2: 共用工具之擴建由做夢 agent 親手完成, 迴圈只做機械檢查(不合之檔逐檔還原)並把結果記入做夢文件之 harness.toolbox
        let dir = path.join(t.dir, 'toolbox')
        let toolbox = createToolbox({ dir, indexSeed: '# 索引\n', checkFile: ({ src }) => (/BAD/.test(src) ? ['內容不合'] : []) })
        let records = createFileRecords({ nodeDir: path.join(t.dir, 'nodes'), dreamDir: path.join(t.dir, 'dreams'), trashDir: path.join(t.dir, 'trash') })
        let arsi = createArsi({
            records,
            workDir: path.join(t.dir, 'work'),
            toolbox,
            dispatch: async (role, a) => {
                //假做夢: 寫一個合格之工具(有記入 expansion)、一個不合格者(應被還原)、一個合格但未記入 expansion 者, 並更新索引
                fs.mkdirSync(path.join(dir, 'snippets'), { recursive: true })
                fs.writeFileSync(path.join(dir, 'snippets', 'good.mjs'), 'export let f = () => 1\n')
                fs.writeFileSync(path.join(dir, 'snippets', 'bad.mjs'), 'BAD\n')
                fs.writeFileSync(path.join(dir, 'snippets', 'extra.mjs'), 'export let g = () => 2\n')
                fs.writeFileSync(path.join(dir, 'README.md'), '# 索引\nsnippets/good.mjs\nsnippets/bad.mjs\nsnippets/extra.mjs\n')
                fs.writeFileSync(path.join(path.dirname(a.logFile), 'dream.json'), JSON.stringify({
                    ...dream([{ nodeId: 'n1', trust: 'trusted', action: 'accept', evidence: [], issues: [] }]),
                    expansion: [
                        { item: '甲', sources: ['n1'], decision: 'built', files: ['rsi/toolbox/snippets/good.mjs'], verify: '跑過' },
                        { item: '乙', decision: 'built', files: ['rsi/toolbox/snippets/bad.mjs'], verify: '跑過' },
                        { item: '丙', decision: 'declined', note: '只有一個節點用得到' },
                    ],
                }))
                return { ok: true, agent: { kind: 'fake', model: `fake-${role}` } }
            },
            verify: async () => ({ ok: true }),
            texts: { nodeBrief: () => 'b', nodePrompt: () => 'p', nodeTemplate: () => ({}), dreamBrief: () => 'd', dreamPrompt: () => 'p', dreamTemplate: () => ({}) },
        })
        let r = await arsi.runDream({ round: 2, nodeIds: ['n1'] })
        assert.deepEqual(r.issues, [], 'expansion 之格式合格')
        assert(fs.existsSync(path.join(dir, 'snippets', 'good.mjs')), '合格者留下')
        assert(!fs.existsSync(path.join(dir, 'snippets', 'bad.mjs')), '不合者還原(本次新增 ⇒ 刪除)')
        let tb = r.doc.harness.toolbox
        assert.deepEqual(tb.reverted, [{ rel: 'snippets/bad.mjs', why: '內容不合' }])
        assert.deepEqual([tb.changed.added.sort(), tb.changed.changed], [['snippets/extra.mjs', 'snippets/good.mjs'], ['README.md']])
        assert(tb.issues.some((x) => /snippets\/extra\.mjs 未記入 expansion/.test(x)))
        assert(tb.issues.some((x) => /snippets\/bad\.mjs 不在共用工具區/.test(x)))
        assert.equal(tb.ok, false)
        assert.deepEqual(r.doc.harness.tally.expansion, { total: 3, built: 2, updated: 0, declined: 1, core: 0 })
        assert.equal(r.doc.expansion.length, 3)
        let md = fs.readFileSync(records.paths.dreamMd(2), 'utf8')
        let at = ['## 4. 擴建', '〔新增〕甲', 'rsi/toolbox/snippets/good.mjs', '已還原 1 檔', '## 5. 專案文件之更新'].map((s) => md.indexOf(s))
        assert(at.every((i) => i > 0) && at.every((i, k) => k === 0 || i > at[k - 1]), `做夢文件之擴建一節依序含處置、檔、還原紀錄, 且在專案文件之更新之前: ${at}`)
    })

    it('未注入共用工具區之專案:做夢文件不出現擴建一節,節號不變', async () => {
        let a = setup(t, { dreamJson: dream([{ nodeId: 'n1', trust: 'trusted', action: 'accept', evidence: [], issues: [] }]) })
        let r = await a.arsi.runDream({ round: 3, nodeIds: ['n1'] })
        assert.equal(r.toolbox, null)
        assert.equal(r.doc.expansion, undefined)
        let md = fs.readFileSync(a.records.paths.dreamMd(3), 'utf8')
        assert(!md.includes('擴建') && md.includes('## 4. 專案文件之更新') && md.includes('## 5. 迴圈之執行結果'))
    })
})
