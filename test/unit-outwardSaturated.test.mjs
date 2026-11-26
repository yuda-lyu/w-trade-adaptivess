import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts, OUT_SATURATED_NOTE } from '../src/domain/texts.mjs'
import { makeProject, outwardNoteOf, saturatedLineOf, OUT_CHECK_MIN } from '../src/domain/domain.mjs'
import { checkDreamAgentPart, tallyDream, renderDreamMd } from '../src/arsi/records.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//向外飽和之宣告(規則 R-REC-29;使用端提案)
//  spec: ①可選之臂皆已試過、且做夢本輪於 synthesis.overview.outwardSaturated 宣告(或續存)「現行資訊範圍內已無可試之向外方向」({ basis: 非空字串 })時,
//          方向可只含向內(驗證類),不必另以完整評估預先核對新機制;輪末摘要之配比附註記為「向外 0(已宣告向外飽和)」,不標示為違反
//        ②做夢任務書之配比只在派做夢當下可選之臂皆已試過(context.outward.nUntried === 0)時多列「例外之二」一句;其餘情形任務書與範本逐字不變
//        ③任務書所寫之附註文字與輪末摘要(outwardNoteOf)同一字串(OUT_SATURATED_NOTE);未試之臂數同一算法(untriedOf),而時點不同:
//          任務書以派做夢前之樹、摘要以套用做夢之審計後之樹(同例外之一之既有寫法)—— 做夢判刪除某臂之唯一已試節點時,該臂回到未試、摘要照舊標示(任務書之例外之二寫明此情形)
//        ④既有之判定不變:尚有未試之臂 ⇒ 照舊標示(宣告不適用);預先核對達 OUT_CHECK_MIN 種 ⇒ 照舊記「預先核對皆不成立」;未宣告 ⇒ 輸出與改前逐字相同
//        ⑤派做夢之站點只有輪末鉤子(afterRound → arsi.runDream):一般輪次、只做夢輪次、補做夢(pendingDream → redream)同一給法
//        ⑥宣告只看「向外 0 條」(同例外之一; 不另核方向是否皆為驗證類)、須每輪重申(迴圈不跨輪記憶)
describe('向外飽和之宣告(R-REC-29)', function () {

    describe('outwardNoteOf(純函數)', function () {
        //legacy, 改前(1.0.16)之判定(逐字照錄; 用以核對未宣告時之輸出不變)
        let legacy = ({ nOut, nDirs, nUntried, nChecked }) => {
            if (nOut > 0 || nDirs === 0) {
                return ''
            }
            if (nUntried > 0) {
                return `;**無向外之方向**(未試之可選臂尚有 ${nUntried} 個)`
            }
            return nChecked >= OUT_CHECK_MIN
                ? `;向外 0(預先核對皆不成立;${nChecked} 種)`
                : `;**無向外之方向**(可選之臂皆已試過;預先核對而皆無內容之向外候選 ${nChecked} 種,未達 ${OUT_CHECK_MIN} 種)`
        }

        it('可選之臂皆已試過、向外 0、有方向、已宣告 ⇒ 記「向外 0(已宣告向外飽和)」(不標示為違反)', () => {
            assert.equal(OUT_SATURATED_NOTE, ';向外 0(已宣告向外飽和)')
            assert.equal(outwardNoteOf({ nOut: 0, nDirs: 1, nUntried: 0, nChecked: 0, saturated: true }), OUT_SATURATED_NOTE)
            assert.equal(outwardNoteOf({ nOut: 0, nDirs: 4, nUntried: 0, nChecked: OUT_CHECK_MIN - 1, saturated: true }), OUT_SATURATED_NOTE, '預先核對未達門檻亦可(不必另核)')
            assert(!OUT_SATURATED_NOTE.includes('**'), '不以粗體標示(不是違反)')
        })

        it('宣告不改變其餘之判定:有向外或無方向 ⇒ 空;尚有未試之臂 ⇒ 照舊標示;預先核對達門檻 ⇒ 照舊記「預先核對皆不成立」', () => {
            assert.equal(outwardNoteOf({ nOut: 1, nDirs: 2, nUntried: 0, nChecked: 0, saturated: true }), '')
            assert.equal(outwardNoteOf({ nOut: 0, nDirs: 0, nUntried: 0, nChecked: 0, saturated: true }), '')
            assert.equal(outwardNoteOf({ nOut: 0, nDirs: 3, nUntried: 2, nChecked: 0, saturated: true }), ';**無向外之方向**(未試之可選臂尚有 2 個)', '尚有未試之臂時宣告不適用')
            assert.equal(outwardNoteOf({ nOut: 0, nDirs: 1, nUntried: 0, nChecked: OUT_CHECK_MIN, saturated: true }), `;向外 0(預先核對皆不成立;${OUT_CHECK_MIN} 種)`)
        })

        it('未宣告(saturated 非 true:未給、false、字串、1、物件)⇒ 各種輸入之輸出與改前逐字相同', () => {
            let n = 0
            for (let nOut of [0, 1]) {
                for (let nDirs of [0, 1, 3]) {
                    for (let nUntried of [0, 2]) {
                        for (let nChecked of [0, OUT_CHECK_MIN - 1, OUT_CHECK_MIN, OUT_CHECK_MIN + 2]) {
                            let o = { nOut, nDirs, nUntried, nChecked }
                            let want = legacy(o)
                            assert.equal(outwardNoteOf(o), want, JSON.stringify(o))
                            for (let saturated of [undefined, null, false, 'true', 1, {}, [true]]) {
                                assert.equal(outwardNoteOf({ ...o, saturated }), want, JSON.stringify({ ...o, saturated }))
                                n++
                            }
                        }
                    }
                }
            }
            assert.equal(n, 2 * 3 * 2 * 4 * 7)
        })
    })

    describe('做夢任務書與範本(texts.mjs)', function () {
        let st0 = getSettings()
        let st = { ...st0, rsi: { ...st0.rsi, guides: false } }
        let texts = makeTexts({ st, FD_ROOT: st.FD_ROOT })
        let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
        let node = { nodeId: 'n1aaaaaaaaaaaaaa', arms: ['A04_act'], base: null, S: -12.3, worst: -30.1, excess: 8.2, ladder: 0, vetoed: false, claimedS: -12.3, nEvals: 6, nFull: 4, nFullSel: 3, issues: [], docMd: 'rsi/records/nodes/n1.md', workDir: 'rsi/work/n1', shareable: [], armProposals: [] }
        let ctx = (extra = {}) => ({ round: 9, nodeIds: [node.nodeId], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r009'), context: { nodes: [node], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox, ...extra } })
        let CLAUSE_HEAD = '**例外之二(向外可為 0 條;現行資訊範圍內已無可試之向外方向)**'

        it('可選之臂皆已試過(outward.nUntried === 0)⇒ 配比多列例外之二:只含驗證類可、不必另以完整評估預先核對;填 outwardSaturated;摘要之附註文字與 outwardNoteOf 同一字串', () => {
            let d = texts.dreamBrief(ctx({ outward: { nUntried: 0 } }))
            assert(d.includes(CLAUSE_HEAD))
            assert(d.includes('方向可只含驗證類(向外 0 條),**不必另以完整評估預先核對新機制**'))
            assert(d.includes('`synthesis.overview.outwardSaturated`') && d.includes('`{ basis: 已核之機制與結果,或首次宣告之輪次與其依據 }`'))
            assert(d.includes('每輪重申;未填即不適用此例外'), '須每輪重申(迴圈不跨輪記憶)')
            assert(d.includes(`輪末摘要即記為「${OUT_SATURATED_NOTE.slice(1)}」`), '附註文字取自同一常數')
            assert(d.includes('改提 `guidance.improvements`(評估器之新能力、專案以外之資訊)或 `guidance.armProposals`(新臂)照舊每輪皆可'), '改提之管道為任務書既有之欄')
            assert(!/D\d{1,3}\b/.test(d.slice(d.indexOf(CLAUSE_HEAD), d.indexOf('向外之方向同樣須寫', d.indexOf(CLAUSE_HEAD)))), '不引使用端之條款編號')
            assert(d.includes('此時不受上句「照舊須有向外」之限'), '與例外之一之末句之關係寫明')
            assert(d.includes('輪末摘要依套用你之審計後之樹判定:你判刪除之節點若是某臂唯一之已試者,該臂即回到未試,此例外不適用(須有向外)。'), '摘要之時點與其後果寫明')
            assert(d.includes('日後有新資訊源或新臂開放時,向外照常。'), '日後有新資訊源或新臂時向外照常')
        })

        it('只多一句、位置緊接例外之一之末句;拿掉該句即與未給 outward 者逐字相同', () => {
            let a = texts.dreamBrief(ctx())
            let b = texts.dreamBrief(ctx({ outward: { nUntried: 0 } }))
            assert.notEqual(a, b)
            let i = b.indexOf(CLAUSE_HEAD)
            let j = b.indexOf('向外之方向同樣須寫', i)
            assert(i > 0 && j > i)
            assert(b.slice(0, i).endsWith('尚有未試之臂、或只核了 1 ~ 2 種者,照舊須有向外。'), '緊接例外之一之末句')
            assert.equal(b.slice(0, i) + b.slice(j), a)
        })

        it('未給 outward、尚有未試之臂、或 nUntried 非數字 0 ⇒ 任務書與範本逐字不變(不列例外之二、範本無 outwardSaturated)', () => {
            let a = texts.dreamBrief(ctx())
            let ta = JSON.stringify(texts.dreamTemplate(ctx()))
            for (let outward of [undefined, null, 0, 'x', [], {}, { nUntried: 2 }, { nUntried: '0' }, { nUntried: null }, { nUntried: -0.5 }, { nUntried: [0] }]) {
                let c = outward === undefined ? ctx() : ctx({ outward })
                assert.equal(texts.dreamBrief(c), a, JSON.stringify(outward))
                assert.equal(JSON.stringify(texts.dreamTemplate(c)), ta, JSON.stringify(outward))
            }
            assert(!a.includes('例外之二') && !a.includes('outwardSaturated') && !ta.includes('outwardSaturated'))
        })

        it('範本:nUntried === 0 時整體研判多 outwardSaturated: null(位於 outwardChecked 與 prevReview 之間),其餘欄與鍵序不變', () => {
            let ov0 = texts.dreamTemplate(ctx()).synthesis.overview
            let ov1 = texts.dreamTemplate(ctx({ outward: { nUntried: 0 } })).synthesis.overview
            assert.strictEqual(ov1.outwardSaturated, null)
            let k0 = Object.keys(ov0)
            let k1 = Object.keys(ov1)
            assert.deepEqual(k1, [...k0.slice(0, k0.indexOf('prevReview')), 'outwardSaturated', ...k0.slice(k0.indexOf('prevReview'))])
            let { outwardSaturated, ...rest } = ov1
            assert.deepStrictEqual(rest, ov0)
        })

        it('只做夢輪次(帶要求;任務書列「## 0. 主控之要求」)亦依同一條件列出(兩者獨立)', () => {
            let req = { request: { why: '請重審', dreamOnly: true } }
            let d1 = texts.dreamBrief(ctx({ ...req, outward: { nUntried: 0 } }))
            assert(d1.includes('## 0. 主控之要求') && d1.includes(CLAUSE_HEAD))
            let d2 = texts.dreamBrief(ctx({ ...req, outward: { nUntried: 1 } }))
            assert(d2.includes('## 0. 主控之要求') && !d2.includes(CLAUSE_HEAD))
            //未給 outward 之只做夢任務書不變(與拿掉例外之二者逐字相同)
            let d3 = texts.dreamBrief(ctx(req))
            let i = d1.indexOf(CLAUSE_HEAD)
            let j = d1.indexOf('向外之方向同樣須寫', i)
            assert.equal(d1.slice(0, i) + d1.slice(j), d3)
        })
    })

    describe('做夢文件之檢核、計數與渲染(records.mjs)', function () {
        let good = { families: [{ name: '甲', nodes: ['n1'], basis: 'b' }], coverage: { verdict: 'concentrated', why: 'w' }, progress: { verdict: 'flat', why: 'w' }, localOptimum: { risk: 'high', why: 'w' }, blindSpots: [], adjust: '向外 0', prevReview: '' }
        let part = (ov) => ({
            audits: [{ nodeId: 'n1', trust: 'trusted', action: 'accept', evidence: ['e'], issues: [] }],
            synthesis: { summary: 's', worked: [], failed: [], patterns: [], overview: ov },
            guidance: { directions: [{ type: 'verify', newFamily: false, arms: ['A'], base: 'n1', claim: 'c', rationale: 'r', expect: 'e' }], avoid: [], openQuestions: [], toolRequests: [] },
            docsUpdated: [{ file: 'f', what: 'w' }],
        })
        let BASIS = '前 4 輪之向外預先核對 12 種皆無內容(首次宣告於其末輪)'

        it('outwardSaturated 為選配:{ basis: 非空字串 } 合格;null / 未給合格;其餘形狀皆被指出(訊息不帶輸入值)', () => {
            assert.deepEqual(checkDreamAgentPart(part({ ...good, outwardSaturated: { basis: BASIS } }), ['n1']), [])
            assert.deepEqual(checkDreamAgentPart(part({ ...good, outwardSaturated: null }), ['n1']), [])
            assert.deepEqual(checkDreamAgentPart(part(good), ['n1']), [])
            for (let bad of [{ basis: '' }, { basis: '   ' }, { basis: 3 }, { basis: ['a'] }, {}, 'x', true, 1, [], [{ basis: 'b' }]]) {
                let e = checkDreamAgentPart(part({ ...good, outwardSaturated: bad }), ['n1'])
                assert.equal(e.filter((x) => /overview\.outwardSaturated/.test(x)).length, 1, JSON.stringify(bad))
                assert(!e.some((x) => x.includes('"x"') || x.includes('   ')), '訊息不回顯輸入值')
            }
        })

        it('tallyDream:合格之宣告 ⇒ overview.outwardSaturated 為 true;未給或不合格 ⇒ 無此鍵(既有欄與鍵序不變)', () => {
            assert.equal(tallyDream(part({ ...good, outwardSaturated: { basis: BASIS } })).overview.outwardSaturated, true)
            let legacyKeys = ['coverage', 'progress', 'localOptimum', 'nFamilies', 'outwardChecked']
            for (let ov of [good, { ...good, outwardSaturated: null }, { ...good, outwardSaturated: { basis: ' ' } }, { ...good, outwardSaturated: 'yes' }]) {
                let t = tallyDream(part(ov)).overview
                assert.deepEqual(Object.keys(t), legacyKeys, JSON.stringify(ov.outwardSaturated))
                assert.deepEqual(t, { coverage: 'concentrated', progress: 'flat', localOptimum: 'high', nFamilies: 1, outwardChecked: 0 })
            }
        })

        it('渲染:合格之宣告於整體研判列一行(依據之換行併為一行);未給者不列', () => {
            let md = renderDreamMd({ round: 9, scope: { nodes: ['n1'] }, ...part({ ...good, outwardSaturated: { basis: `  ${BASIS}\n第二行  ` } }) })
            assert(md.includes(`- 已宣告現行資訊範圍內已無可試之向外方向:${BASIS} 第二行\n`), md.slice(md.indexOf('據此之調整') - 10, md.indexOf('據此之調整') + 200))
            //換行為 \r\n 且前後有縮排空白(多行)⇒ 每個換行連同其前後之空白併為單一空白
            let md2 = renderDreamMd({ round: 9, scope: { nodes: ['n1'] }, ...part({ ...good, outwardSaturated: { basis: '  甲項\r\n   乙項  \r\n\t丙項  ' } }) })
            assert(md2.includes('- 已宣告現行資訊範圍內已無可試之向外方向:甲項 乙項 丙項\n'), md2.slice(md2.indexOf('已宣告') - 10, md2.indexOf('已宣告') + 120))
            assert(!renderDreamMd({ round: 9, scope: { nodes: ['n1'] }, ...part(good) }).includes('已宣告現行資訊範圍內'))
            assert(!renderDreamMd({ round: 9, scope: { nodes: ['n1'] }, ...part({ ...good, outwardSaturated: { basis: '' } }) }).includes('已宣告現行資訊範圍內'))
        })
    })

    //接縫不用替身: 真 w-recursi + 本套件真實之領域(makeProject 之輪末鉤子 → 任務書與範本 → arsi.runDream → 做夢文件 → 輪末摘要); 只有「派工」換成假的
    describe('輪末鉤子:任務書之條件與輪末摘要之判定一致(真 w-recursi + 真領域 + 假派工)', function () {
        this.timeout(120000)
        let t
        beforeEach(() => {
            t = makeTmp('outSat')
        })
        afterEach(() => {
            t.cleanup()
        })
        let good = { families: [{ name: '甲', nodes: [], basis: 'b' }], coverage: { verdict: 'concentrated', why: 'w' }, progress: { verdict: 'flat', why: 'w' }, localOptimum: { risk: 'high', why: 'w' }, blindSpots: [], adjust: '向外 0', prevReview: '' }
        //mk, 於暫存夾組裝專案; 假派工: 做夢依範本交付(整體研判 good + 選配之宣告;方向 1 條 = 以已執行之節點為起點之驗證 ⇒ 向內 1、向外 0)
        let mk = ({ saturated }) => {
            let st = getSettings()
            let d = path.join(t.dir, 'proj')
            st.rsi.root = path.join(d, 'rsi')
            st.rsi.docLimits = false //輪末鉤子之專案文件自動整理(R-REC-17)取本庫自身之 sgud; 測試不得改寫入版控之文件(R-PKG-10)
            st.rsi.guides = false //本段斷言任務書含 / 不含特定字樣; 任務書末所附之寫法守則為可編輯之檔(可含該等字樣)⇒ 不附(同文字段之 guides: false)
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
            let calls = { dream: 0, briefs: [], templates: [] }
            //ref.directions(選配): 做夢所交之方向陣列(可為空陣列 = 0 條); ref.checked(選配): 做夢自報已預先核對而皆無內容之向外候選種數
            let ref = { baseId: null, baseArm: null, audits: [], saturated, direction: null, directions: null, checked: null }
            let dispatch = async (role, { prompt }) => {
                if (role !== 'dream') {
                    throw new Error('fake: 節點派工例外')
                }
                calls.dream++
                let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
                let wd = path.resolve(st.FD_ROOT, m[1])
                calls.briefs.push(fs.readFileSync(path.join(wd, 'brief.md'), 'utf8'))
                let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
                calls.templates.push(tpl)
                let dream = {
                    audits: ref.audits,
                    synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [], overview: { ...good, ...(ref.checked ? { outwardChecked: { kinds: ref.checked, files: ['f_pre.json'] } } : {}), ...(ref.saturated ? { outwardSaturated: { basis: '向外預先核對 12 種皆無內容' } } : {}) } },
                    guidance: { directions: ref.directions || [ref.direction || { type: 'verify', newFamily: false, arms: [ref.baseArm], base: ref.baseId, claim: '窗軸於嚴格半庫仍成立', rationale: '驗證', expect: '交付版 = 起點;判定 = 六半皆正' }], avoid: [], openQuestions: [], improvements: [], armProposals: [] },
                    expansion: [],
                    docsUpdated: [],
                }
                fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
                return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
            }
            let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
            P.rsi.init()
            //putExecuted, 樹上放一個已執行之節點(其臂即「已試」)
            //  evidence(選配): 例 { offDefArms: [臂] }(依修訂後之定義不屬該臂 ⇒ 不算已試)、{ inactiveArms: [臂] }(試過而於交付版關閉 ⇒ 仍算已試)
            let putExecuted = (arms, round = 1, evidence = null) => {
                let spec = { arms: [...arms].sort(), base: null }
                let id = P.idOf(spec)
                P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round, ...(evidence ? { evidence } : {}) })
                return id
            }
            return { P, calls, ref, putExecuted }
        }
        let mixLine = (hk) => hk.lines.find((l) => l.startsWith('任務類型:')) || ''
        //satLines, 輪末摘要內以「向外飽和」起首之各行(規則 R-REC-46: 已宣告者恰 1 行、未宣告者 0 行)
        let satLines = (hk) => hk.lines.filter((l) => l.startsWith('向外飽和'))

        it('可選之臂皆已試過 + 做夢宣告 ⇒ 任務書列例外之二、範本含 outwardSaturated、摘要記「向外 0(已宣告向外飽和)」、做夢文件列宣告', async () => {
            let { P, calls, ref, putExecuted } = mk({ saturated: true })
            assert(P.selectable.length >= 2)
            let all = P.selectable.map((a) => a.id)
            ref.baseId = putExecuted(all)
            ref.baseArm = all[0]
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.equal(calls.dream, 1)
            assert(calls.briefs[0].includes('**例外之二(向外可為 0 條;現行資訊範圍內已無可試之向外方向)**'))
            assert(calls.briefs[0].includes(`輪末摘要即記為「${OUT_SATURATED_NOTE.slice(1)}」`))
            assert('outwardSaturated' in calls.templates[0].synthesis.overview && calls.templates[0].synthesis.overview.outwardSaturated === null)
            assert(mixLine(hk).endsWith(`配比 向外 0、向內 1${OUT_SATURATED_NOTE}`), mixLine(hk))
            assert(fs.readFileSync(P.records.paths.dreamMd(2), 'utf8').includes('- 已宣告現行資訊範圍內已無可試之向外方向:向外預先核對 12 種皆無內容'))
        })

        it('可選之臂皆已試過而未宣告 ⇒ 任務書照列例外之二(條件是臂已盡),摘要照舊標示「無向外之方向」', async () => {
            let { P, calls, ref, putExecuted } = mk({ saturated: false })
            let all = P.selectable.map((a) => a.id)
            ref.baseId = putExecuted(all)
            ref.baseArm = all[0]
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert(calls.briefs[0].includes('**例外之二('))
            assert(mixLine(hk).endsWith(`配比 向外 0、向內 1;**無向外之方向**(可選之臂皆已試過;預先核對而皆無內容之向外候選 0 種,未達 ${OUT_CHECK_MIN} 種)`), mixLine(hk))
        })

        it('尚有未試之可選臂 ⇒ 任務書不列例外之二、範本無 outwardSaturated;做夢仍宣告者摘要照舊標示「未試之可選臂尚有 N 個」', async () => {
            let { P, calls, ref, putExecuted } = mk({ saturated: true })
            let first = P.selectable[0].id
            ref.baseId = putExecuted([first])
            ref.baseArm = first
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert(!calls.briefs[0].includes('例外之二') && !calls.briefs[0].includes('outwardSaturated'))
            assert(!('outwardSaturated' in calls.templates[0].synthesis.overview))
            assert(mixLine(hk).endsWith(`配比 向外 0、向內 1;**無向外之方向**(未試之可選臂尚有 ${P.selectable.length - 1} 個)`), mixLine(hk))
        })

        it('兩個時點:派做夢前可選之臂皆已試過、做夢判刪除某臂之唯一已試節點 ⇒ 任務書列例外之二(含其後果之句);摘要以套用後之樹為準,該臂回到未試而照舊標示「未試之可選臂尚有 1 個」', async () => {
            let { P, calls, ref, putExecuted } = mk({ saturated: true })
            let all = P.selectable.map((a) => a.id)
            let X = all[all.length - 1]
            ref.baseId = putExecuted(all.slice(0, -1), 1)
            ref.baseArm = all[0]
            //臂 X 唯一之已試者: 本輪之節點(做夢判刪除)
            let kid = putExecuted([X], 2)
            //審計之處置須有節點文件(無者略過; arsi.applyDream)
            P.records.putNodeDoc({ nodeId: kid, round: 2, spec: { arms: [X], base: null } })
            ref.audits = [{ nodeId: kid, trust: 'untrusted', action: 'delete', evidence: ['假:成品無法重現'], issues: ['假:判刪除'], deleteWhy: '假:成品無法重現' }]
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [P.rsi.store.getNode(kid)] })
            assert.equal(calls.dream, 1)
            //派做夢前: X 由 kid 試過 ⇒ 可選之臂皆已試過 ⇒ 列例外之二
            assert(calls.briefs[0].includes('**例外之二(向外可為 0 條;現行資訊範圍內已無可試之向外方向)**'))
            assert(calls.briefs[0].includes('你判刪除之節點若是某臂唯一之已試者,該臂即回到未試,此例外不適用(須有向外)'))
            assert('outwardSaturated' in calls.templates[0].synthesis.overview)
            //套用後: kid 已刪除(不再為已執行)⇒ X 回到未試 ⇒ 宣告不適用, 照舊標示
            let kn = P.rsi.store.getNode(kid)
            assert(!kn || kn.status !== 'executed', '做夢之刪除已套用')
            assert(hk.lines.some((l) => l.includes('審計 1 節點 ⇒ 採納 0、重做 0(成功 0)、刪除 1')), hk.lines.join(' / ').slice(0, 800))
            assert(mixLine(hk).endsWith('配比 向外 0、向內 1;**無向外之方向**(未試之可選臂尚有 1 個)'), mixLine(hk))
            assert(!mixLine(hk).includes(OUT_SATURATED_NOTE))
        })

        it('「已試之臂」之口徑:evidence.offDefArms(依修訂後之定義不屬該臂)不算已試 ⇒ 該臂未試 ⇒ 任務書不列例外之二、摘要照舊標示;evidence.inactiveArms(試過而於交付版關閉)仍算已試 ⇒ 列例外之二、摘要記宣告', async () => {
            //offDefArms: 臂 X 只出現於「依修訂後之定義不屬 X」之節點 ⇒ 未試
            let a = mk({ saturated: true })
            let all = a.P.selectable.map((x) => x.id)
            let X = all[all.length - 1]
            a.ref.baseId = a.putExecuted(all.slice(0, -1), 1)
            a.ref.baseArm = all[0]
            a.putExecuted([X], 2, { offDefArms: [X] })
            a.P.requestDreamOnly({ why: '重審' })
            let hk1 = await a.P.domain.hooks.afterRound({ round: 3, nodes: [] })
            assert(!a.calls.briefs[0].includes('例外之二'))
            assert(mixLine(hk1).endsWith('配比 向外 0、向內 1;**無向外之方向**(未試之可選臂尚有 1 個)'), mixLine(hk1))
        })

        it('「已試之臂」之口徑:evidence.inactiveArms(試過而於交付版關閉之臂)仍算已試 ⇒ 任務書列例外之二、摘要記宣告', async () => {
            let a = mk({ saturated: true })
            let all = a.P.selectable.map((x) => x.id)
            let X = all[all.length - 1]
            //樹上只有一個節點、其指派之臂含全部可選之臂, 其中 X 於交付版關閉(未作用)
            a.ref.baseId = a.putExecuted(all, 1, { inactiveArms: [X] })
            a.ref.baseArm = all[0]
            a.P.requestDreamOnly({ why: '重審' })
            let hk2 = await a.P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert(a.calls.briefs[0].includes('**例外之二('))
            assert(mixLine(hk2).endsWith(`配比 向外 0、向內 1${OUT_SATURATED_NOTE}`), mixLine(hk2))
        })

        it('兩個時點與向外之判定連動:派做夢前臂已盡、做夢判刪除某臂 X 之唯一已試節點並給一條以 X 為臂之從零探索 ⇒ 摘要以套用後之樹判定:X 回到未試 ⇒ 該方向計為向外(配比 向外 1)', async () => {
            let { P, ref, putExecuted } = mk({ saturated: true })
            let all = P.selectable.map((a) => a.id)
            let X = all[all.length - 1]
            ref.baseId = putExecuted(all.slice(0, -1), 1)
            ref.baseArm = all[0]
            let kid = putExecuted([X], 2)
            P.records.putNodeDoc({ nodeId: kid, round: 2, spec: { arms: [X], base: null } })
            ref.audits = [{ nodeId: kid, trust: 'untrusted', action: 'delete', evidence: ['假:成品無法重現'], issues: ['假:判刪除'], deleteWhy: '假:成品無法重現' }]
            ref.direction = { type: 'explore', newFamily: false, arms: [X], base: null, rationale: '探索剛回到未試之臂', expect: '回測期之 S 較高' }
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [P.rsi.store.getNode(kid)] })
            assert(mixLine(hk).endsWith('配比 向外 1、向內 0'), mixLine(hk))
        })

        it('補做夢之路徑(pendingDream → redream)與一般輪次同一給法:可選之臂皆已試過 ⇒ 任務書列例外之二、範本含 outwardSaturated、摘要記宣告', async () => {
            let { P, calls, ref, putExecuted } = mk({ saturated: true })
            let all = P.selectable.map((a) => a.id)
            ref.baseId = putExecuted(all, 2)
            ref.baseArm = all[0]
            P.records.putNodeDoc({ nodeId: ref.baseId, round: 2, spec: { arms: [...all].sort(), base: null } })
            ref.audits = [{ nodeId: ref.baseId, trust: 'trusted', action: 'accept', evidence: ['e'], issues: [] }]
            let pd = P.pendingDream()
            assert(pd && pd.round === 2 && pd.nodeIds.includes(ref.baseId), '第 2 輪之節點已入樹而無做夢文件')
            let hk = await P.redream(2)
            assert.equal(calls.dream, 1)
            assert(calls.briefs[0].includes('**例外之二(向外可為 0 條;現行資訊範圍內已無可試之向外方向)**'))
            assert(calls.templates[0].synthesis.overview.outwardSaturated === null)
            assert(mixLine(hk).endsWith(`配比 向外 0、向內 1${OUT_SATURATED_NOTE}`), mixLine(hk))
            assert(hk.lines.some((l) => l.includes('審計 1 節點 ⇒ 採納 1')), hk.lines.join(' / ').slice(0, 800))
            assert.strictEqual(P.pendingDream(), null)
        })

        it('宣告須每輪重申(迴圈不跨輪記憶):上一輪宣告過、本輪做夢文件未填 ⇒ 本輪摘要照舊標示', async () => {
            //第 2 輪之做夢宣告 ⇒ 記「向外 0(已宣告向外飽和)」; 第 3 輪(同一專案、同一棵樹)之做夢不填 ⇒ 標示「無向外之方向」, 任務書仍列例外之二(條件是臂已盡)
            let { P, calls, ref, putExecuted } = mk({ saturated: true })
            let all = P.selectable.map((a) => a.id)
            ref.baseId = putExecuted(all)
            ref.baseArm = all[0]
            P.requestDreamOnly({ why: '重審' })
            let hk1 = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert(mixLine(hk1).endsWith(OUT_SATURATED_NOTE), mixLine(hk1))
            ref.saturated = false
            P.requestDreamOnly({ why: '再審' })
            let hk2 = await P.domain.hooks.afterRound({ round: 3, nodes: [] })
            assert.equal(calls.dream, 2)
            assert(calls.briefs[1].includes('**例外之二('))
            assert(!mixLine(hk2).includes(OUT_SATURATED_NOTE) && mixLine(hk2).includes('**無向外之方向**'), mixLine(hk2))
        })

        //「向外飽和」一行(規則 R-REC-46): 配比之附註於預先核對達門檻時記「預先核對皆不成立」、於方向 0 條時為空 ⇒ 看不出做夢已宣告, 故另列一行
        it('「向外飽和」一行:已宣告者恰列 1 行(緊接配比一列之後;下一輪之方向數取自做夢文件、未試之可選臂數取自套用後之樹);未宣告者不列', async () => {
            let a = mk({ saturated: true })
            let all = a.P.selectable.map((x) => x.id)
            a.ref.baseId = a.putExecuted(all)
            a.ref.baseArm = all[0]
            a.P.requestDreamOnly({ why: '重審' })
            let hk1 = await a.P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.deepEqual(satLines(hk1), [saturatedLineOf({ saturated: true, nExplore: 0, nVerify: 1, nUntried: 0 })], hk1.lines.join(' / ').slice(0, 800))
            assert.equal(hk1.lines.indexOf(satLines(hk1)[0]), hk1.lines.indexOf(mixLine(hk1)) + 1, '緊接配比一列之後')
            //未宣告(其餘相同)⇒ 不列
            let b = mk({ saturated: false })
            b.ref.baseId = b.putExecuted(b.P.selectable.map((x) => x.id))
            b.ref.baseArm = all[0]
            b.P.requestDreamOnly({ why: '重審' })
            let hk2 = await b.P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert.deepEqual(satLines(hk2), [])
        })

        it('「向外飽和」一行:預先核對達門檻(配比之附註記「預先核對皆不成立」而非宣告)而已宣告 ⇒ 仍列出宣告', async () => {
            let { P, ref, putExecuted } = mk({ saturated: true })
            let all = P.selectable.map((a) => a.id)
            ref.baseId = putExecuted(all)
            ref.baseArm = all[0]
            ref.checked = OUT_CHECK_MIN
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert(mixLine(hk).includes('預先核對皆不成立') && !mixLine(hk).includes(OUT_SATURATED_NOTE), mixLine(hk))
            assert.deepEqual(satLines(hk), [saturatedLineOf({ saturated: true, nExplore: 0, nVerify: 1, nUntried: 0 })])
        })

        it('「向外飽和」一行:方向 0 條(配比之附註為空)而已宣告 ⇒ 仍列出宣告(探索 0、驗證 0)', async () => {
            let { P, ref, putExecuted } = mk({ saturated: true })
            let all = P.selectable.map((a) => a.id)
            ref.baseId = putExecuted(all)
            ref.baseArm = all[0]
            ref.directions = []
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert(mixLine(hk).endsWith('配比 向外 0、向內 0'), mixLine(hk))
            assert.deepEqual(satLines(hk), [saturatedLineOf({ saturated: true, nExplore: 0, nVerify: 0, nUntried: 0 })])
        })

        it('「向外飽和」一行:尚有未試之可選臂而做夢仍宣告 ⇒ 照列宣告並帶未試之臂數(適用與否仍由配比之附註表示:照舊標示)', async () => {
            let { P, ref, putExecuted } = mk({ saturated: true })
            let first = P.selectable[0].id
            ref.baseId = putExecuted([first])
            ref.baseArm = first
            P.requestDreamOnly({ why: '重審' })
            let hk = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
            assert(mixLine(hk).includes('**無向外之方向**'), mixLine(hk))
            assert.deepEqual(satLines(hk), [saturatedLineOf({ saturated: true, nExplore: 0, nVerify: 1, nUntried: P.selectable.length - 1 })])
        })
    })

    describe('saturatedLineOf(純函數;R-REC-46)', function () {
        it('已宣告(saturated === true)⇒ 一行:以「向外飽和」起首、含下一輪之方向數與未試之可選臂數(字面值)', () => {
            assert.equal(saturatedLineOf({ saturated: true, nExplore: 0, nVerify: 1, nUntried: 0 }), '向外飽和:**做夢已宣告**現行資訊範圍內已無可試之向外方向(下一輪之方向 探索 0、驗證 1;未試之可選臂 0 個);其後之出路(新資訊源、新臂、結束搜尋)待主控裁示')
            let s = saturatedLineOf({ saturated: true, nExplore: 2, nVerify: 3, nUntried: 7 })
            assert(s.startsWith('向外飽和') && s.includes('探索 2、驗證 3') && s.includes('未試之可選臂 7 個'), s)
            assert(s.length < 400 && !/\r|\n/.test(s), '單行、不逾一頁摘要之截斷長度(每行取前 400 字)')
        })

        it('未宣告(saturated 非 true:未給、null、false、字串、1、物件、陣列)⇒ 空字串', () => {
            for (let saturated of [undefined, null, false, 'true', 1, {}, [true]]) {
                assert.equal(saturatedLineOf({ saturated, nExplore: 0, nVerify: 1, nUntried: 0 }), '', JSON.stringify(saturated))
            }
        })
    })
})
