import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import * as TX from '../src/domain/texts.mjs'
import * as DM from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//保留期與其他標的之正負號之用法(規則 R-REC-32;Gitea #172,使用端提案;使用端之裁示:正負號只作佐證、不放寬)
//  spec: ①做夢任務書(共同儲存區之說明內;有總表時才列)明列「號之取得與號之正負不作派方向、定先後、選入樹版本之理由,亦不入整體研判之依據;家族層級之讀號只寫於歸類之附記」,
//          取代原「整體研判之『卡在局部最佳點之風險』請把它列為依據之一」(與前者牴觸);其餘文字不變;節點任務書不變
//        ②輪末摘要之機械提示:方向之理由、整體研判之調整與三項判定之依據出現保留期 / 他標 / 他幣 / 號之字樣 ⇒ 列「待核對」一行(只提示、不否決、不讀文意);
//          機制家族之歸類(families)不掃描(家族層級之讀號為所許);「號」之常見複合詞(編號、訊號等)不算;無則不列(摘要不變)
//  取得 SIGNS_CLAUSE / signsMentionOf 用命名空間匯入(改前之碼無此二者時,測試仍能載入而於斷言處紅,非載入即失敗)
//  期望之句以字面寫於本檔(spec 之翻譯),另斷言匯出之常數與之相同
let KEY = '號之取得與號之正負不作派方向、定先後、選入樹版本之理由,亦不入整體研判之依據'
let CLAUSE = '**號之取得與號之正負不作派方向、定先後、選入樹版本之理由,亦不入整體研判之依據**(整體研判之三項判定與 `adjust` 只依回測期與迴圈內可觀察之證據);家族層級之讀號只寫於機制家族之歸類(`families`)之附記。'
let OLD = '整體研判之「卡在局部最佳點之風險」請把它列為依據之一。'
let signsMentionOf = (d) => DM.signsMentionOf(d)

describe('保留期與其他標的之正負號之用法(R-REC-32)', function () {

    describe('做夢任務書(texts.mjs)', function () {
        let t
        before(() => {
            t = makeTmp('signsTexts')
        })
        after(() => {
            t.cleanup()
        })
        let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
        let node = { nodeId: 'n1aaaaaaaaaaaaaa', arms: ['A04_act'], base: null, S: -12.3, worst: -30.1, excess: 8.2, ladder: 0, vetoed: false, claimedS: -12.3, nEvals: 6, nFull: 4, nFullSel: 3, issues: [], docMd: 'rsi/records/nodes/n1.md', workDir: 'rsi/work/n1', from: null, type: 'explore' }
        //textsOf, 以暫存之狀態根組任務書(store: 有總表; cross: 另有其他標的之號之檔)
        let textsOf = (name, { store = false, cross = false } = {}) => {
            let st0 = getSettings()
            let root = path.join(t.dir, name, 'rsi')
            fs.mkdirSync(path.join(root, 'picks'), { recursive: true })
            if (store) {
                fs.writeFileSync(path.join(root, 'picks', 'INDEX.md'), '# 總表\n', 'utf8')
            }
            if (cross) {
                fs.writeFileSync(path.join(root, 'picks', '_cross.json'), '{}', 'utf8')
            }
            let st = { ...st0, rsi: { ...st0.rsi, root, guides: false } }
            let texts = TX.makeTexts({ st, FD_ROOT: st.FD_ROOT })
            let ctx = { round: 9, nodeIds: [node.nodeId], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r009'), context: { nodes: [node], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox, armProposals: { ledger: null, fromNodes: [] } } }
            let nctx = { workDir: path.join(st.records.workDir, 'n1'), task: { goal: 'g', type: 'explore', claim: null, arms: [{ id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }], base: null, refs: [], direction: null, toolbox }, round: 9, nodeId: node.nodeId, attempt: 1 }
            return { texts, ctx, nctx, st }
        }

        it('有總表 ⇒ 做夢任務書恰列一次該句(R-REC-32 ①:含要旨與附記之處),原「列為依據之一」之句不再出現;位置緊接「亦不為湊出正號而反覆換設計;」;匯出之常數與該句相同', () => {
            let { texts, ctx } = textsOf('a', { store: true })
            let d = texts.dreamBrief(ctx)
            assert.equal(TX.SIGNS_CLAUSE, CLAUSE)
            assert.equal(d.split(CLAUSE).length, 2, '恰一次')
            assert(CLAUSE.includes(KEY) && CLAUSE.includes('家族層級之讀號只寫於機制家族之歸類(`families`)之附記'))
            assert(!d.includes(OLD) && !d.includes('列為依據之一'))
            assert(d.includes(`亦不為湊出正號而反覆換設計;${CLAUSE}`))
            //以原句換回即為改前之文字(只換這一句)
            let back = d.replace(CLAUSE, OLD)
            assert(back.includes(`亦不為湊出正號而反覆換設計;${OLD}`) && back.split(OLD).length === 2)
        })

        it('有其他標的之號 ⇒ 該句之後照舊接其他標的之說明(讀法與限制同保留期之正負號)', () => {
            let { texts, ctx } = textsOf('b', { store: true, cross: true })
            let d = texts.dreamBrief(ctx)
            assert(d.includes(`${CLAUSE}總表另列**其他標的之正負號**`))
            assert(d.includes('讀法與限制同保留期之正負號'))
        })

        it('無總表 ⇒ 不列該句(共同儲存區之說明整段不列);節點任務書(有總表時亦)不列該句;原始碼中該句只在做夢任務書之一處引用', () => {
            let { texts, ctx } = textsOf('c', { store: false })
            assert(!texts.dreamBrief(ctx).includes(KEY))
            //節點任務書: 有總表時亦不列(使用端之裁示之範圍只在做夢;節點之任務書只說明號之欄)
            let r = textsOf('c2', { store: true, cross: true })
            assert(!r.texts.nodeBrief(r.nctx).includes(KEY) && !r.texts.nodeBrief(r.nctx).includes('整體研判之三項判定與'))
            let src = fs.readFileSync(new URL('../src/domain/texts.mjs', import.meta.url), 'utf8')
            assert.equal(src.split('\' + SIGNS_CLAUSE + ').length, 2)
            assert.equal(src.split('\n').filter((l) => l.includes('SIGNS_CLAUSE') && !l.trim().startsWith('//') && !l.trim().startsWith('*')).length, 3, '定義、引用、匯出各一')
        })
    })

    describe('signsMentionOf(純函數)', function () {
        let doc = (o = {}) => ({
            guidance: { directions: o.dirs || [{ rationale: '回測期之窗軸平原' }, { rationale: '驗證' }] },
            synthesis: { overview: { families: [{ name: '甲', nodes: [], basis: o.basis || '同一資訊源' }], coverage: { verdict: 'concentrated', why: o.cov || 'w' }, progress: { verdict: 'flat', why: o.pro || 'w' }, localOptimum: { risk: 'high', why: o.lo || 'w' }, blindSpots: o.blind || [], adjust: o.adj || '向內 1', prevReview: o.prev || '' }, summary: o.summary || '摘要' },
            openQuestions: o.oq || [],
        })

        it('無字樣 ⇒ [];各欄出現保留期 / 他標 / 其他標的 / 他幣 / 其他幣種 / holdout / 號 ⇒ 依序列出所在之欄(各欄各用不同之字樣)', () => {
            assert.deepEqual(signsMentionOf(doc()), [])
            assert.deepEqual(signsMentionOf(doc({ dirs: [{ rationale: '入樹以取得保留期之號' }, { rationale: 'x' }, { rationale: '他標之內容' }] })), ['方向 1 之理由', '方向 3 之理由'])
            assert.deepEqual(signsMentionOf(doc({ adj: '取得號之前不再長同族' })), ['整體研判之調整'])
            assert.deepEqual(signsMentionOf(doc({ cov: '其他標的亦然' })), ['集中度之依據'])
            assert.deepEqual(signsMentionOf(doc({ pro: 'HOLDOUT 皆正' })), ['進度之依據'])
            assert.deepEqual(signsMentionOf(doc({ lo: '條件區比重高者之內容號皆負' })), ['局部最佳點之風險之依據'])
            //他幣(Gitea #172 主控裁示加列;較早之做夢文件寫「他幣」): 各欄各一
            assert.deepEqual(signsMentionOf(doc({ dirs: [{ rationale: '甲' }, { rationale: '他幣之內容' }] })), ['方向 2 之理由'])
            assert.deepEqual(signsMentionOf(doc({ adj: '其他幣種皆負' })), ['整體研判之調整'])
            assert.deepEqual(signsMentionOf(doc({ cov: '他幣', pro: '其他幣種' })), ['集中度之依據', '進度之依據'])
            //五欄齊列(各欄之字樣互異:任一欄之掃描或標籤錯置即不同)
            assert.deepEqual(signsMentionOf(doc({ dirs: [{ rationale: '正負號' }], adj: '保留期', cov: '他標', pro: 'holdout', lo: '他幣' })), ['方向 1 之理由', '整體研判之調整', '集中度之依據', '進度之依據', '局部最佳點之風險之依據'])
        })

        it('機制家族之歸類不掃描(家族層級之讀號為所許);盲點、待決問題、前次回顧、摘要亦不掃描(掃描之欄照提案);「號」之常見複合詞不算', () => {
            assert.deepEqual(signsMentionOf(doc({ basis: '附記:同族三個成品之保留期之號皆正;他標;他幣' })), [])
            assert.deepEqual(signsMentionOf(doc({ blind: ['保留期之號未讀'], prev: '他標之號', oq: ['保留期?'], summary: '保留期之號' })), [])
            for (let w of ['編號', '代號', '序號', '符號', '記號', '括號', '字號', '型號', '帳號', '口號', '問號', '逗號', '句號', '頓號', '冒號', '引號', '分號', '番號', '掛號', '年號']) {
                assert.deepEqual(signsMentionOf(doc({ adj: `依臂之${w}排序` })), [], w)
            }
            //複合詞與單獨之號並存 ⇒ 仍列
            assert.deepEqual(signsMentionOf(doc({ adj: '臂代號之外,另依號之取得排序' })), ['整體研判之調整'])
        })

        it('與正負號無關之常見複合詞(訊號、信號、頭號、條號、版號、單號、行號、列號、賬號;號碼、號稱)不算;正負號、同號、異號等照列;「標號」不排除', () => {
            //前字之排除: 各詞單獨出現於各欄皆不列(方向之理由、調整、三項判定之依據)
            for (let w of ['訊號', '信號', '頭號', '條號', '版號', '單號', '行號', '列號', '賬號']) {
                let s = `選集之每隻${w} 5 倍`
                assert.deepEqual(signsMentionOf(doc({ dirs: [{ rationale: s }], adj: s, cov: s, pro: s, lo: s })), [], w)
            }
            //後字之排除: 號碼、號稱(前字非排除者)
            for (let w of ['節點號碼', '此線號稱自適應']) {
                assert.deepEqual(signsMentionOf(doc({ adj: w, lo: w })), [], w)
            }
            //與正負號有關者照列(前字、後字皆非排除者;含不排除之「標號」)
            for (let w of ['正負號', '正號', '負號', '同號', '異號', '反號', '翻號', '加號後', '內容號', '號之取得', '號(家族層級)', '兩標號皆正']) {
                assert.deepEqual(signsMentionOf(doc({ adj: `依${w}排序` })), ['整體研判之調整'], w)
            }
            //排除詞與單獨之號並存 ⇒ 仍列(以真實文件之形為例: 訊號之倍數與號之家族層級判讀同句)
            assert.deepEqual(signsMentionOf(doc({ dirs: [{ rationale: '入樹後作號之家族層級之判讀。選集之每隻訊號 5.05 倍' }] })), ['方向 1 之理由'])
            assert.deepEqual(signsMentionOf(doc({ lo: '訊號之同號' })), ['局部最佳點之風險之依據'])
            assert.deepEqual(signsMentionOf(doc({ lo: '號碼之外另依號' })), ['局部最佳點之風險之依據'])
        })

        it('欄缺或型別不合 ⇒ 略過、不拋錯;不改動輸入', () => {
            for (let d of [null, undefined, {}, { guidance: null }, { guidance: { directions: 'x' } }, { guidance: { directions: [null, 3, { rationale: 5 }, { rationale: ['保留期'] }] } }, { synthesis: { overview: 'x' } }, { synthesis: { overview: { adjust: 7, coverage: '保留期', progress: null, localOptimum: { why: ['號'] } } } }]) {
                assert.deepEqual(signsMentionOf(d), [], JSON.stringify(d))
            }
            let d0 = doc({ adj: '保留期' })
            let s0 = JSON.stringify(d0)
            signsMentionOf(d0)
            assert.equal(JSON.stringify(d0), s0)
        })
    })

    //接縫不用替身: 真 w-recursi + 本套件真實之領域(makeProject 之輪末鉤子 → 任務書 → arsi.runDream → 做夢文件 → 輪末摘要); 只有「派工」換成假的
    describe('輪末鉤子:任務書列該句、摘要之待核對一行(真 w-recursi + 真領域 + 假派工)', function () {
        this.timeout(120000)
        let t
        beforeEach(() => {
            t = makeTmp('signsHook')
        })
        afterEach(() => {
            t.cleanup()
        })
        let ov0 = { families: [{ name: '甲', nodes: [], basis: '附記:同族之保留期之號' }], coverage: { verdict: 'concentrated', why: 'w' }, progress: { verdict: 'flat', why: 'w' }, localOptimum: { risk: 'high', why: 'w' }, blindSpots: [], adjust: '向內 1', prevReview: '' }
        let mk = () => {
            let st = getSettings()
            let d = path.join(t.dir, 'proj')
            st.rsi.root = path.join(d, 'rsi')
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
            let calls = { dream: 0, briefs: [] }
            let ref = { baseId: null, baseArm: null, overview: ov0, rationale: '回測期之窗軸平原' }
            let dispatch = async (role, { prompt }) => {
                if (role !== 'dream') {
                    throw new Error('fake: 節點派工例外')
                }
                calls.dream++
                let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
                let wd = path.resolve(st.FD_ROOT, m[1])
                calls.briefs.push(fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'))
                let dream = {
                    audits: [],
                    synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [], overview: ref.overview },
                    guidance: { directions: [{ type: 'verify', newFamily: false, arms: [ref.baseArm], base: ref.baseId, claim: '窗軸之平原', rationale: ref.rationale, expect: '交付版 = 起點;判定 = 三抽之均' }], avoid: [], openQuestions: [], toolRequests: [] },
                    expansion: [],
                    docsUpdated: [],
                }
                fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
                return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
            }
            let P = DM.makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
            P.rsi.init()
            //共同儲存區之總表(有總表時任務書才列該句)
            fs.mkdirSync(path.join(st.rsi.root, 'picks'), { recursive: true })
            fs.writeFileSync(path.join(st.rsi.root, 'picks', 'INDEX.md'), '# 總表\n', 'utf8')
            let all = P.selectable.map((a) => a.id)
            let spec = { arms: [all[0]], base: null }
            let id = P.idOf(spec)
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1 })
            ref.baseId = id
            ref.baseArm = all[0]
            return { P, calls, ref }
        }
        let hintOf = (hk) => hk.lines.filter((l) => l.startsWith('待核對:'))

        it('方向之理由與局部最佳點之風險之依據提及號 ⇒ 摘要列一行待核對(列出兩欄與任務書之要旨;不否決:方向照常入前緣);任務書列該句;該行位於整體研判之後', async () => {
            let { P, calls, ref } = mk()
            ref.rationale = '入樹,使同族有多個選集供保留期之號之家族層級判讀'
            ref.overview = { ...ov0, localOptimum: { risk: 'high', why: '他標之內容號皆負' } }
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.equal(calls.dream, 1)
            assert(calls.briefs[0].includes(CLAUSE))
            let h = hintOf(hk)
            assert.equal(h.length, 1, hk.lines.join('\n'))
            assert(h[0].startsWith('待核對:方向 1 之理由、局部最佳點之風險之依據出現保留期 / 他標 / 他幣 / 號之字樣'))
            assert(h[0].includes(KEY) && h[0].includes('只提示、不否決'))
            //位置: 緊接整體研判一行之後
            let iOv = hk.lines.findIndex((l) => l.startsWith('整體研判:'))
            assert(iOv >= 0 && hk.lines.indexOf(h[0]) === iOv + 1, hk.lines.join('\n'))
            //不否決: 方向照常提出(輪末摘要列入前緣之計數)
            assert(!hk.lines.some((l) => l.startsWith('方向未入前緣')), hk.lines.join('\n'))
            assert(hk.lines.some((l) => l.includes('方向 1 條(入前緣 1)')), hk.lines.join('\n'))
        })

        it('只寫他幣(較早之寫法)⇒ 亦列一行待核對', async () => {
            let { P, ref } = mk()
            ref.rationale = '入樹,供他幣之判讀'
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            let h = hintOf(hk)
            assert.equal(h.length, 1, hk.lines.join('\n'))
            assert(h[0].startsWith('待核對:方向 1 之理由出現'))
        })

        it('未提及(家族之附記提及者不算)⇒ 摘要無待核對一行', async () => {
            let { P, ref } = mk()
            ref.rationale = '回測期之窗軸平原;臂代號依序;每隻訊號 3 倍'
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.deepEqual(hintOf(hk), [])
            assert(hk.lines.some((l) => l.startsWith('整體研判:')), '整體研判一行照常')
        })
    })
})
