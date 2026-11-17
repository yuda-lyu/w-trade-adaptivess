import assert from 'assert'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as PS from '../src/domain/pickStore.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//共同儲存區之其他標的之正負號(規則 R-REC-30;Gitea #168,使用端提案,純新增)與保留期之守門(同批收嚴):
//  _cross.json(使用端之上層所寫;同一挑選模組原樣不改、於另一標的之策略庫上評估;回測期與保留期各給績效與挑選內容之號)只讀、只收 "+" / "-" / "0";
//  無此檔(或形狀不合)者共同儲存區之各檔與未支援此檔之版本(1.0.17)逐位相同(各檔之 ext 與其欄位定義為 R-REC-31 之新增,比對前先去除);
//  _holdout.json 亦只收 "+" / "-" / "0"(兩個檔之資訊界線相同: 數字不入專案、只有號)
//  以命名空間匯入: 於未支援之版本(修前)各案分別失敗,不因匯入具名之項不存在而整檔無法載入
describe('共同儲存區:其他標的之正負號(規則 R-REC-30)', function () {
    let { buildPickStore, infoOf, FIELD_DEFS, COLUMNS } = PS
    let ids = ['aaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbb2', 'ccccccccccccccc3', 'ddddddddddddddd4']
    //各策略之數字皆不同(含 S、七相位、組成對照), 使欄位錯位可被看出
    let doc = (id, k) => ({
        nodeId: id,
        round: 3 + k,
        attempt: 1,
        status: 'executed',
        spec: { arms: ['A01_nt', 'B14_pitKey'].slice(0, 1 + (k % 2)), base: k === 2 ? ids[0] : null },
        task: { goal: 'g', type: k === 1 ? 'verify' : 'explore', claim: k === 1 ? `主張 ${k}` : undefined },
        plan: {},
        code: {},
        results: { claimed: {} },
        conclusion: { outcome: 'improved', summary: `結論之摘要 ${k}` },
        harness: {
            ok: true,
            summary: [],
            notes: [],
            checks: { issues: [`提示 ${k}`] },
            score: { S: 10.5 + 11 * k, ladder: k % 4, flags: { vetoed: k === 3, why: [] } },
            raw: { replays: [{ S: 9 + k, comp: 10 + k, recent: 12 + k }], metrics: { selHash: `h${k}`, ledgerKey: 'k', ms: { pick: 4200 + k }, sel: { sigPerPick: 2.5 + k, longRatio: 0.6 - k / 10 }, op: { eqYr: { mean: 12.345 + k, min: -1.2 - k, byPhase: [5, -1.2, 9, 20, 30, 11, 12].map((v) => v + k) }, monthlyOrders: { mean: 100.04 + k }, peakHold: { max: 30 - k }, winRate: 0.45678 + k / 100 }, nullSideAct: { excess: 40.26 + k, p: 0.0154 }, ext: { nullRecentAct: { side: { excess: 20.1 + k, p: 0.03 } } } } },
        },
        audit: k === 0 ? { round: 3, by: 'm', trust: 'trusted', action: 'accept', evidence: [], issues: [], inactiveArms: [] } : undefined,
    })
    let pick = (k) => `export const meta = { arms: ['A01_nt'], params: { take: ${40 + k} }, desc: '成品 ${k}' }\nexport default function pick(ctx) {\n    return []\n}\n`
    //專案: 4 個策略、做夢之家族歸類、_holdout.json(只含號; ho 可換)
    let mkProj = (t, ho = { [ids[1]]: { perf: '+', content: '-' }, [ids[2]]: { perf: '0', content: null } }) => {
        let d = path.join(t.dir, 'proj')
        let st = { FD_ROOT: d, rsi: { root: path.join(d, 'rsi') }, records: { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), workDir: path.join(d, 'rsi/work') } }
        for (let k of Object.keys(st.records)) {
            fs.mkdirSync(st.records[k], { recursive: true })
        }
        ids.forEach((id, k) => {
            fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
            fs.writeFileSync(path.join(st.records.workDir, id, 'pick.mjs'), pick(k), 'utf8')
            fs.writeFileSync(path.join(st.records.nodeDir, `${id}.json`), JSON.stringify(doc(id, k)), 'utf8')
        })
        fs.writeFileSync(path.join(st.records.dreamDir, 'r003.json'), JSON.stringify({ round: 3, synthesis: { overview: { families: [{ name: '家族甲', nodes: [ids[1].slice(0, 8)] }] } } }), 'utf8')
        let dir = path.join(st.rsi.root, 'picks')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, '_holdout.json'), JSON.stringify({ from: '2026-08-01T00:00:00', asOf: '2026-11-10T00:00:00', items: ho }), 'utf8')
        return { st, dir }
    }
    //oldShape: 現行輸出 → 1.0.17 之形(去除 R-REC-31 之新增: 各列之 ext、欄位定義之 ext 一列、README 欄位表之 ext 一列; 未支援 ext 之版本為不變換)
    let oldShape = (rel, text) => {
        if (rel === 'index.json' || rel.endsWith('/info.json')) {
            let o = JSON.parse(text)
            for (let x of rel === 'index.json' ? o.items : [o]) {
                delete x.ext
            }
            if (o.fields) {
                o.fields = o.fields.filter((f) => !f.key.startsWith('ext.'))
            }
            return JSON.stringify(o, null, 1)
        }
        if (rel === 'README.md') {
            return text.split('\n').filter((l) => !l.startsWith('| `ext.')).join('\n')
        }
        return text
    }
    //snapOf: 區內之產出檔(不含以底線起首之輸入檔)→ 去除 ext 之新增並正規化(產生時刻換成 T)之內容
    let norm = (s) => s.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'T')
    let snapOf = (dir, raw = false) => {
        let out = {}
        let walk = (d, rel) => {
            for (let ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
                let r = rel ? `${rel}/${ent.name}` : ent.name
                if (ent.isDirectory()) {
                    walk(path.join(d, ent.name), r)
                }
                else if (!ent.name.startsWith('_')) {
                    let text = fs.readFileSync(path.join(d, ent.name), 'utf8')
                    out[r] = norm(raw ? text : oldShape(r, text))
                }
            }
        }
        walk(dir, '')
        return out
    }
    let hashOf = (snap) => crypto.createHash('sha1').update(Object.keys(snap).map((k) => `${k}\n${snap[k]}`).join('\n')).digest('hex')
    let readIdx = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
    let headerOf = (cols) => `| ${cols.map(([tt]) => tt).join(' | ')} |`
    let ALL_NULL = { backtest: { perf: null, content: null }, holdout: { perf: null, content: null } }
    //舊版(未支援 _cross.json 與 ext;1.0.17)之總表欄
    let OLD_HEADER = '| 節點 | 輪 | 類型 | 臂(←起點) | 審計 | 回測期 S / 階梯 | 七相位 平均 / 最差 / 為正 | 挑選內容 內建 / 近 90 日(p) | 月均單 / 做多比例 | 保留期 績效 / 內容 | 機制(成品自述或結論摘要) |'
    //舊版(1.0.17)於本合成專案(無 _cross.json;_holdout.json 只含號)之產出檔之雜湊(正規化產生時刻;以 1.0.17 之發布版實跑取得)—— 共同儲存區之格式有意改變時才更新
    let OLD_HASH = 'd010b9257cdba85f415385e4d2fb2b2e149c03ee'
    //非號之值(各一): 數字、數字字串、前後有空白者、全形號、其他字串、布林、物件、陣列、空字串
    let BAD = [37.4159, -12.87, 0, 1, '41.23', '+0.5', '-7', ' +', '+ ', '＋', 'plus', 'pos', true, false, { v: '+' }, ['+'], '']
    let t
    afterEach(() => {
        if (t) {
            t.cleanup()
            t = null
        }
    })

    it('無 _cross.json:各產出檔與舊版逐位相同(去除 ext 之新增後之雜湊);總表之欄、欄位定義、info.json 之鍵、說明皆無其他標的;回傳之 cross 為 null', async () => {
        t = makeTmp('pickStoreCross0')
        let { st, dir } = mkProj(t)
        let r = await buildPickStore(st)
        assert.deepEqual([r.n, r.holdoutSigned], [4, 2])
        let snap = snapOf(dir)
        assert.equal(hashOf(snap), OLD_HASH, `產出檔之雜湊 ${hashOf(snap)}`)
        assert.strictEqual(r.cross, null)
        let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
        assert.equal(md.split('\n').find((l) => l.startsWith('| 節點')), OLD_HEADER)
        assert.equal(headerOf(COLUMNS), OLD_HEADER, 'COLUMNS 不變(其他標的之欄另列於 CROSS_COLUMNS)')
        let idx = readIdx(dir)
        assert.deepEqual(idx.fields, FIELD_DEFS.map(([key, note]) => ({ key, note })), '無此檔 ⇒ 欄位定義 = FIELD_DEFS')
        assert(idx.items.every((x) => !('cross' in x)), 'info 不含 cross 鍵')
        assert.equal(Object.keys(idx.items[0]).includes('cross'), false)
        for (let f of Object.keys(snap)) {
            assert(!snap[f].includes('其他標的') && !snap[f].includes('cross'), `${f} 不提其他標的`)
        }
    })

    it('有 _cross.json:總表於「保留期」之後插兩欄(回測期、保留期之績效 / 內容);info.json 帶 cross(四個號,未列者 null,鍵在 holdout 之後、files 之前);欄位定義與說明附其他標的;該檔原樣保留;回傳統計;移除該檔後重產 ⇒ 回到舊版', async () => {
        t = makeTmp('pickStoreCross1')
        let { st, dir } = mkProj(t)
        let fp = path.join(dir, '_cross.json')
        let text = JSON.stringify({ note: 'n', items: { [ids[0]]: { backtest: { perf: '-', content: '+' }, holdout: { perf: '+', content: '0' } }, [ids[1]]: { backtest: { perf: '0' } } } })
        fs.writeFileSync(fp, text, 'utf8')
        let r = await buildPickStore(st)
        assert.deepEqual(r.cross, { invalid: false, signed: 2, ignored: 0 })
        assert.equal(fs.readFileSync(fp, 'utf8'), text, '正負號檔原樣保留')
        let idx = readIdx(dir)
        let by = Object.fromEntries(idx.items.map((x) => [x.id, x]))
        assert.deepEqual(by[ids[0]].cross, { backtest: { perf: '-', content: '+' }, holdout: { perf: '+', content: '0' } })
        assert.deepEqual(by[ids[1]].cross, { backtest: { perf: '0', content: null }, holdout: { perf: null, content: null } })
        assert.deepEqual(by[ids[2]].cross, ALL_NULL)
        assert.deepEqual(Object.keys(by[ids[0]]), ['id', 'short', 'round', 'type', 'arms', 'base', 'claimKey', 'claim', 'family', 'status', 'design', 'backtest', 'ext', 'holdout', 'cross', 'files'])
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ids[0], 'info.json'), 'utf8')).cross, by[ids[0]].cross)
        //保留期之號照舊(不受其他標的影響)
        assert.deepEqual(by[ids[1]].holdout, { perf: '+', content: '-', asOf: '2026-11-10T00:00:00' })
        assert.deepEqual(idx.fields, [...FIELD_DEFS, ...PS.CROSS_FIELD_DEFS].map(([key, note]) => ({ key, note })))
        assert.deepEqual(PS.CROSS_FIELD_DEFS.map(([k]) => k), ['cross.backtest.perf / content', 'cross.holdout.perf / content'])
        let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
        let lines = md.split('\n')
        let hd = lines.find((l) => l.startsWith('| 節點'))
        assert.equal(hd, OLD_HEADER.replace('| 保留期 績效 / 內容 |', '| 保留期 績效 / 內容 | 其他標的 回測期 績效 / 內容 | 其他標的 保留期 績效 / 內容 |'))
        assert.equal(headerOf(PS.CROSS_COLUMNS), '| 其他標的 回測期 績效 / 內容 | 其他標的 保留期 績效 / 內容 |')
        let rowOf = (id) => lines.find((l) => l.startsWith(`| \`${id.slice(0, 8)}\``)).split(' | ')
        let ci = hd.split(' | ').indexOf('其他標的 回測期 績效 / 內容')
        assert.deepEqual(rowOf(ids[0]).slice(ci - 1, ci + 2), ['· / ·', '- / +', '+ / 0'], '保留期 / 其他標的回測期 / 其他標的保留期')
        assert.deepEqual(rowOf(ids[1]).slice(ci - 1, ci + 2), ['+ / -', '0 / ·', '· / ·'])
        assert.deepEqual(rowOf(ids[3]).slice(ci, ci + 2), ['· / ·', '· / ·'])
        assert(md.includes('> 「保留期」與「其他標的」各欄只有正負號(「·」= 未算)'))
        let readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
        assert(readme.includes('## 其他標的之正負號') && readme.includes('**數字不提供,只提供正負號**') && readme.includes('同一家族多個成品是否同號'))
        assert(readme.indexOf('## 保留期之正負號') < readme.indexOf('## 其他標的之正負號') && readme.indexOf('## 其他標的之正負號') < readme.indexOf('## 欄位'))
        assert(readme.includes('| `cross.backtest.perf / content` |') && readme.includes('| `cross.holdout.perf / content` |'))
        //移除該檔後重產 ⇒ 回到舊版之產出(逐位)
        fs.rmSync(fp)
        let r2 = await buildPickStore(st)
        assert.strictEqual(r2.cross, null, '無此檔 ⇒ 回傳之 cross 為 null')
        assert.equal(hashOf(snapOf(dir)), OLD_HASH)
    })

    it('只收正負號:數字、數字字串、前後有空白者、全形號、其他字串、布林、物件、陣列一律忽略(該處為 null、計入 ignored);整段或整個策略之形狀不合者同;檔內之數字、期間與其他欄不出現在任何產出檔', async () => {
        t = makeTmp('pickStoreCross2')
        let { st, dir } = mkProj(t)
        let items = {
            //逐一放在 backtest.perf;其餘三格為合法之號(此組之 id 不在共同儲存區內 ⇒ 只供 crossOf 之逐項核對)
            ...Object.fromEntries(BAD.map((v, i) => [`x${i}`, { backtest: { perf: v, content: '+' }, holdout: { perf: '-', content: '0' } }])),
            [ids[0]]: { backtest: { perf: 5551.7, content: '-' }, holdout: { perf: '+0.25', content: { mean: 6662.8 } }, qqExtra: { qqVal: 7773.9 } },
            [ids[1]]: { backtest: 8884.1, holdout: ['+', '-'] },
            [ids[2]]: 9995.2,
            [ids[3]]: { backtest: { perf: '+', content: '+', qqA: 1112.3 }, holdout: { perf: '-', content: '-', qqB: 2223.4 } },
        }
        fs.writeFileSync(path.join(dir, '_cross.json'), JSON.stringify({ note: '其他標的 3141.5', periods: { backtest: { from: '2025-10-06T00:00:00' } }, mean: 4242.6, items }), 'utf8')
        let r = await buildPickStore(st)
        //只讀共同儲存區內之策略: ids[0] 3 個值(5551.7、'+0.25'、物件), ids[1] 兩段, ids[2] 整個策略 ⇒ 6
        assert.deepEqual(r.cross, { invalid: false, signed: 2, ignored: 6 })
        let by = Object.fromEntries(readIdx(dir).items.map((x) => [x.id, x.cross]))
        assert.deepEqual(by[ids[0]], { backtest: { perf: null, content: '-' }, holdout: { perf: null, content: null } })
        assert.deepEqual(by[ids[1]], ALL_NULL)
        assert.deepEqual(by[ids[2]], ALL_NULL)
        assert.deepEqual(by[ids[3]], { backtest: { perf: '+', content: '+' }, holdout: { perf: '-', content: '-' } }, '只帶四個號, 其他鍵不帶出')
        let snap = snapOf(dir, true)
        for (let f of Object.keys(snap)) {
            for (let s of ['5551.7', '6662.8', '7773.9', '8884.1', '9995.2', '1112.3', '2223.4', '3141.5', '4242.6', '0.25', '2025-10-06', 'qqExtra', 'qqVal', 'qqA', 'qqB', 'periods']) {
                assert(!snap[f].includes(s), `${f} 不得含 ${s}`)
            }
        }
        //crossOf 對每一種非號之值皆忽略並計數(逐一)
        let cr = PS.crossOf({ items })
        for (let i = 0; i < BAD.length; i++) {
            let before = cr.ignored()
            let x = cr.signsOf(`x${i}`)
            assert.deepEqual(x, { backtest: { perf: null, content: '+' }, holdout: { perf: '-', content: '0' } }, `值 ${JSON.stringify(BAD[i])}`)
            assert.equal(cr.ignored() - before, 1, `值 ${JSON.stringify(BAD[i])} 計入 ignored`)
        }
        //四格皆可收 "+" / "-" / "0"(逐字相符)
        let c1 = PS.crossOf({ items: { a: { backtest: { perf: '+', content: '-' }, holdout: { perf: '0', content: '+' } } } })
        assert.deepEqual(c1.signsOf('a'), { backtest: { perf: '+', content: '-' }, holdout: { perf: '0', content: '+' } })
        assert.deepEqual([c1.ignored(), c1.signed()], [0, 1])
        //同一個 id 只讀一次: 重複呼叫回同值之複本、不重複計數(ignored、signed 為所讀之各策略之計數); 回傳可任意改動而不影響其後之讀取
        let c5 = PS.crossOf({ items: { a: { backtest: { perf: '+', content: 7131 }, holdout: { perf: '-' } }, b: { backtest: { perf: 'x' } } } })
        let a1 = c5.signsOf('a')
        assert.deepEqual([c5.ignored(), c5.signed()], [1, 1])
        a1.backtest.perf = 'MUT'
        assert.deepEqual(c5.signsOf('a'), { backtest: { perf: '+', content: null }, holdout: { perf: '-', content: null } })
        c5.signsOf('a')
        c5.signsOf('b')
        c5.signsOf('b')
        assert.deepEqual([c5.ignored(), c5.signed()], [2, 1], '重複讀同一個 id 不重複計數')
        //null / undefined = 未算(不計入 ignored)
        let c2 = PS.crossOf({ items: { a: { backtest: { perf: null }, holdout: null }, b: null } })
        assert.deepEqual(c2.signsOf('a'), ALL_NULL)
        assert.deepEqual(c2.signsOf('b'), ALL_NULL)
        assert.deepEqual(c2.signsOf('zz'), ALL_NULL)
        assert.deepEqual([c2.ignored(), c2.signed()], [0, 0])
        //原型上之鍵不當作策略(只認自有屬性)
        let c3 = PS.crossOf({ items: Object.create({ inherited: { backtest: { perf: '+', content: '+' } } }) })
        assert.deepEqual(c3.signsOf('inherited').backtest, { perf: null, content: null })
        //整段 / 整個策略為陣列(帶同名屬性)亦不取其值
        let c4 = PS.crossOf({ items: { a: Object.assign([], { backtest: { perf: '+', content: '+' } }), b: { backtest: Object.assign(['x'], { perf: '+' }) } } })
        assert.deepEqual(c4.signsOf('a'), ALL_NULL)
        assert.deepEqual(c4.signsOf('b'), ALL_NULL)
    })

    it('檔之形狀不合(非 JSON、頂層非物件、items 非物件或為陣列)⇒ 視同無此檔:產出與舊版逐位相同、回傳 { invalid: true };讀取器回 null', async () => {
        for (let [k, text] of [['notJson', '{ items: '], ['array', '[]'], ['noItems', '{"note":"x"}'], ['itemsArray', '{"items":[{"backtest":{"perf":"+"}}]}'], ['itemsString', '{"items":"+"}'], ['null', 'null']]) {
            t = makeTmp(`pickStoreCross3_${k}`)
            let { st, dir } = mkProj(t)
            fs.writeFileSync(path.join(dir, '_cross.json'), text, 'utf8')
            let r = await buildPickStore(st)
            assert.deepEqual(r.cross, { invalid: true, signed: 0, ignored: 0 }, k)
            assert.equal(hashOf(snapOf(dir)), OLD_HASH, k)
            t.cleanup()
            t = null
        }
        assert.equal(PS.crossOf(null), null)
        for (let v of [undefined, 5, 'x', true, () => 0]) {
            assert.equal(PS.crossOf(v), null, `非物件 ${String(v)}`)
        }
        assert.equal(PS.crossOf([]), null)
        assert.equal(PS.crossOf({ items: [] }), null)
        assert.equal(PS.crossOf({ items: null }), null)
    })

    it('區內尚無策略而有可用之 _cross.json:回傳 { invalid: false, signed: 0, ignored: 0 }、總表有欄無列、不拋錯;無策略而無此檔者回傳 cross 為 null', async () => {
        t = makeTmp('pickStoreCross5')
        let d = path.join(t.dir, 'proj')
        let st = { FD_ROOT: d, rsi: { root: path.join(d, 'rsi') }, records: { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), workDir: path.join(d, 'rsi/work') } }
        for (let k of Object.keys(st.records)) {
            fs.mkdirSync(st.records[k], { recursive: true })
        }
        let dir = path.join(st.rsi.root, 'picks')
        fs.mkdirSync(dir, { recursive: true })
        assert.strictEqual((await buildPickStore(st)).cross, null)
        fs.writeFileSync(path.join(dir, '_cross.json'), JSON.stringify({ items: { [ids[0]]: { backtest: { perf: '+' } } } }), 'utf8')
        let r = await buildPickStore(st)
        assert.deepEqual([r.n, r.cross], [0, { invalid: false, signed: 0, ignored: 0 }], '區內無策略 ⇒ 檔內之項不讀')
        let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
        assert(md.includes('| 其他標的 回測期 績效 / 內容 | 其他標的 保留期 績效 / 內容 |'))
        assert.equal(md.split('\n').filter((l) => l.startsWith('| ')).length, 1, '只有表頭')
    })

    it('infoOf:未給 cross ⇒ 不含 cross 鍵;給 null ⇒ 四值皆 null;直接給物件者亦只帶出合法之號(其餘鍵與非號之值不帶出)', () => {
        let d = doc(ids[0], 0)
        assert(!('cross' in infoOf(d)))
        assert.deepEqual(infoOf(d, { cross: null }).cross, ALL_NULL)
        assert.deepEqual(infoOf(d, { cross: { backtest: { perf: 1.5, content: '+', x: 9 }, holdout: { perf: '-', content: '+5' }, y: 3 } }).cross, { backtest: { perf: null, content: '+' }, holdout: { perf: '-', content: null } })
        assert.deepEqual(infoOf(d, { cross: { backtest: ['+'], holdout: '+' } }).cross, ALL_NULL)
        for (let v of [5, '+', true, () => 0]) {
            assert.deepEqual(infoOf(d, { cross: v }).cross, ALL_NULL, `整體非物件 ${String(v)}`)
        }
        //鑑別前提: 段或整體不是一般物件而帶同名屬性者(帶 perf 之陣列、帶 content 之函數、帶 backtest 之陣列)亦不取其值
        assert.deepEqual(infoOf(d, { cross: { backtest: Object.assign(['x'], { perf: '+' }), holdout: Object.assign(() => 0, { content: '-' }) } }).cross, ALL_NULL)
        assert.deepEqual(infoOf(d, { cross: Object.assign([], { backtest: { perf: '+', content: '+' } }) }).cross, ALL_NULL)
    })

    it('命令列 src/tools/pickStore.mjs:有 _cross.json 時多印其他標的之統計(含忽略數;不印檔內之數字);無此檔時輸出之行與舊版相同(不提其他標的);形狀不合者印「形狀不合(未列)」', () => {
        t = makeTmp('pickStoreCross4')
        let { st, dir } = mkProj(t)
        let root = st.FD_ROOT
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            eval: { ledgerDir: './ledger' },
            rsi: { root: './rsi' },
            records: { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', workDir: './rsi/work' },
            dispatch: {},
        }), 'utf8')
        let run = () => {
            let env = { ...process.env, ARSI_ROOT: root }
            delete env.ARSI_HARNESS
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'pickStore.mjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
        }
        let r0 = run()
        assert.equal(r0.status, 0, r0.out.slice(0, 800))
        assert(/策略 4 個;本次複製\(新增或有變\)4 個;已有保留期正負號者 2 個\n/.test(r0.out) && !r0.out.includes('其他標的'), r0.out.slice(0, 800))
        //有號之策略 2 個(ids[0]、ids[1])、忽略之值 1 個(3517.5): 兩數不同, 使「有號之策略數」與「忽略數」之互換可被看出
        fs.writeFileSync(path.join(dir, '_cross.json'), JSON.stringify({ items: { [ids[0]]: { backtest: { perf: '+', content: 3517.5 } }, [ids[1]]: { holdout: { perf: '-' } } } }), 'utf8')
        let r1 = run()
        assert.equal(r1.status, 0, r1.out.slice(0, 800))
        assert(r1.out.includes('已有保留期正負號者 2 個;已有其他標的正負號者 2 個(檔內不是正負號而忽略之值 1 個)') && !r1.out.includes('3517.5'), r1.out.slice(0, 800))
        //忽略數為 0 時不印括號
        fs.writeFileSync(path.join(dir, '_cross.json'), JSON.stringify({ items: { [ids[0]]: { backtest: { perf: '+' } } } }), 'utf8')
        let r1b = run()
        assert(/已有保留期正負號者 2 個;已有其他標的正負號者 1 個(;略過|\n)/.test(r1b.out) && !r1b.out.includes('忽略之值'), r1b.out.slice(0, 800))
        fs.writeFileSync(path.join(dir, '_cross.json'), '[]', 'utf8')
        let r2 = run()
        assert(r2.out.includes(';其他標的之正負號檔之形狀不合(未列)'), r2.out.slice(0, 800))
    })
})

//保留期之守門(Gitea #168 §7 ① 之同批收嚴): _holdout.json 與 _cross.json 之資訊界線相同 —— 數字不入專案、只有號;只含號者輸出不變(上一組之第 1 案以雜湊釘住)
describe('共同儲存區:保留期之正負號只收 "+" / "-" / "0"(規則 R-REC-30 之同批)', function () {
    let { buildPickStore, infoOf } = PS
    let id = 'aaaaaaaaaaaaaaa1'
    let doc = {
        nodeId: id,
        round: 3,
        spec: { arms: ['A01_nt'], base: null },
        task: { goal: 'g', type: 'explore' },
        conclusion: { summary: '摘要' },
        harness: { ok: true, checks: { issues: [] }, score: { S: 7.5, ladder: 1, flags: { vetoed: false, why: [] } }, raw: { replays: [], metrics: {} } },
    }
    let BAD = [37.4159, -12.87, 0, 1, '41.23', '+0.5', '-7', ' +', '+ ', '＋', 'plus', 'pos', true, false, { v: '+' }, ['+'], '']
    let t
    afterEach(() => {
        if (t) {
            t.cleanup()
            t = null
        }
    })

    it('infoOf:perf / content 各只收 "+" / "-" / "0"(逐字相符);非號之值(數字、數字字串、前後有空白者、全形號、其他字串、布林、物件、陣列)為 null;asOf 照舊', () => {
        for (let s of ['+', '-', '0']) {
            assert.deepEqual(infoOf(doc, { ho: { perf: s, content: s, asOf: 'T1' } }).holdout, { perf: s, content: s, asOf: 'T1' }, s)
        }
        for (let v of BAD) {
            let h = infoOf(doc, { ho: { perf: v, content: v, asOf: 'T1' } }).holdout
            assert.deepEqual(h, { perf: null, content: null, asOf: 'T1' }, `值 ${JSON.stringify(v)}`)
            //另一格為合法之號時不受影響(逐格判定)
            assert.deepEqual(infoOf(doc, { ho: { perf: v, content: '-' } }).holdout, { perf: null, content: '-', asOf: null }, `值 ${JSON.stringify(v)}`)
            assert.deepEqual(infoOf(doc, { ho: { perf: '+', content: v } }).holdout, { perf: '+', content: null, asOf: null }, `值 ${JSON.stringify(v)}`)
        }
        assert.deepEqual(infoOf(doc, { ho: { perf: undefined, content: null } }).holdout, { perf: null, content: null, asOf: null })
        assert.deepEqual(infoOf(doc).holdout, { perf: null, content: null, asOf: null })
    })

    it('buildPickStore:_holdout.json 內不是正負號之值不進入任何產出檔(index.json、info.json、INDEX.md、README.md);holdoutSigned 只計有號者;該檔原樣保留', async () => {
        t = makeTmp('pickStoreHoldoutGuard')
        let d = path.join(t.dir, 'proj')
        let st = { FD_ROOT: d, rsi: { root: path.join(d, 'rsi') }, records: { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), workDir: path.join(d, 'rsi/work') } }
        for (let k of Object.keys(st.records)) {
            fs.mkdirSync(st.records[k], { recursive: true })
        }
        let ids = ['aaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbb2', 'ccccccccccccccc3']
        ids.forEach((x, k) => {
            fs.mkdirSync(path.join(st.records.workDir, x), { recursive: true })
            fs.writeFileSync(path.join(st.records.workDir, x, 'pick.mjs'), `export const meta = { arms: ['A01_nt'], desc: '成品 ${k}' }\nexport default function pick(ctx) {\n    return []\n}\n`, 'utf8')
            fs.writeFileSync(path.join(st.records.nodeDir, `${x}.json`), JSON.stringify({ ...doc, nodeId: x, harness: { ...doc.harness, score: { ...doc.harness.score, S: 7.5 + k } } }), 'utf8')
        })
        let dir = path.join(st.rsi.root, 'picks')
        fs.mkdirSync(dir, { recursive: true })
        let text = JSON.stringify({ from: '2026-08-01T00:00:00', asOf: '2026-11-10T00:00:00', items: { [ids[0]]: { perf: 7137.4219, content: '+' }, [ids[1]]: { perf: '-', content: '8283.6671' }, [ids[2]]: { perf: { mean: 4417.2203 }, content: -5559.8841 } } })
        fs.writeFileSync(path.join(dir, '_holdout.json'), text, 'utf8')
        let r = await buildPickStore(st)
        assert.equal(r.holdoutSigned, 1, '只有 ids[1] 之 perf 為號')
        assert.equal(fs.readFileSync(path.join(dir, '_holdout.json'), 'utf8'), text, '正負號檔原樣保留')
        let by = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).items.map((x) => [x.id, x.holdout]))
        assert.deepEqual(by[ids[0]], { perf: null, content: '+', asOf: '2026-11-10T00:00:00' })
        assert.deepEqual(by[ids[1]], { perf: '-', content: null, asOf: '2026-11-10T00:00:00' })
        assert.deepEqual(by[ids[2]], { perf: null, content: null, asOf: '2026-11-10T00:00:00' })
        for (let f of ['index.json', 'INDEX.md', 'README.md', ...ids.map((x) => `${x}/info.json`)]) {
            let s = fs.readFileSync(path.join(dir, f), 'utf8')
            for (let n of ['7137.4219', '8283.6671', '4417.2203', '5559.8841']) {
                assert(!s.includes(n), `${f} 不得含 ${n}`)
            }
        }
    })
})
