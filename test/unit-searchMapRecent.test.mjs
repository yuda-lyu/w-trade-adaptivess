import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//搜尋地圖之「有內容」與近期活躍度版之組成對照(規則 R-REC-38): 接縫不用替身 —— 真 w-recursi 之樹 + 本套件真實之領域(makeProject 之 writeBoard → writeSearchMap); 節點以 putNode 直接入樹
//  規格: ①成品有近期版之值(metrics.ext.nullRecentAct.side 之 excess 與 p 皆為有限數值)時,「有內容」另須其超額 > 0、p ≤ 內建版所用之同一門檻
//    ②兩版一過一不過者於譜系與看板標「活躍度定義不一致」, 不計入「有內容」與量尺(含子集、各層之「其中有內容者」)③兩者皆過照計; 皆不過照現行(無內容、不標)
//    ④無其值者(未載入、error、缺 p、非數值)之判定與現行逐位相同; 整棵樹皆無其值 ⇒ 搜尋地圖與看板之全文逐字不變(說明之新增句只在樹上至少一個節點有其值時出現)
//    ⑤否決、notContent(R-REC-22)之既有排除不受影響
//  合成資料: 各欄之值逐節點相異(超額、p、可重現、組成之水準、S、操作績效、虛無); 邊界: 內建版之超額 0 / p = 門檻 / 可重現 0.8, 近期版之超額 0 / p = 門檻
describe('搜尋地圖之「有內容」與近期活躍度版之組成對照(規則 R-REC-38)', function () {
    this.timeout(120000)
    let t
    beforeEach(() => {
        t = makeTmp('smRecent')
    })
    afterEach(() => {
        t.cleanup()
    })
    //N, 節點之表: b = 內建之組成對照(nullSideAct)之 [超額, p, 可重現, 組成之水準]; r = 近期版之 side 之 [超額, p](樹 T_rec 所用); 其餘為節點之欄
    let N = [
        { k: 1, b: [12.3, 0.0154, 0.31, 3.1], S: 40.1, round: 1, r: [-2.4, 0.41], sub: true }, //內建過、近期不過 ⇒ 不一致
        { k: 2, b: [8.7, 0.03, 0.52, 4.2], S: 35.2, round: 1, r: [5.6, 0.02], sub: true }, //兩者皆過
        { k: 3, b: [6.1, 0.08, 0.22, 5.3], S: 50.5, round: 1, r: [7.7, 0.01] }, //內建不過(p)、近期過 ⇒ 不一致
        { k: 4, b: [0, 0.012, 0.15, 6.4], S: 20.2, round: 1, r: [0, 0.013] }, //內建不過(超額恰為 0)、近期不過(超額恰為 0)⇒ 皆不過
        { k: 5, b: [3.3, 0.05, 0.44, 7.5], S: 18.4, round: 2, r: [0.1, 0.05] }, //內建過(p 恰為門檻)、近期過(p 恰為門檻)
        { k: 6, b: [4.4, 0.021, 0.8, 8.6], S: 30.3, round: 2, r: [-1.1, 0.6] }, //內建不過(可重現恰為 0.8)、近期不過
        { k: 7, b: [15.5, 0.011, 0.12, 9.7], S: 60.6, round: 1, r: [-0.6, 0.33], vetoed: true }, //否決; 內建過、近期不過
        { k: 8, b: [11.1, 0.014, 0.27, 10.8], S: 45.5, round: 2, r: [-0.9, 0.27], nc: true }, //notContent; 內建過、近期不過
        { k: 9, b: [9.9, 0.02, 0.36, 11.9], S: 42.4, round: 2, r: null, base: 1 }, //起點 = 節點 1; 無近期版之值
    ]
    //mk, 暫存夾之專案 + 依 N 入樹; recentOf(x) → 該節點之 metrics.ext.nullRecentAct(undefined = 不帶此鍵); nullP = 階梯 1 之虛無 p(預設沿用參考設定之 0.05)
    //  x.act = 該節點之選集每隻訊號數為全體隨機之 2 倍以上(量尺之「挑選內容」用近期版); x.rp = 各次重放 [{ S, comp, recent }](看板之「正本與重放之均」); patch(node) = 讀出節點時改值(見 ⑥; 其餘案不用)
    let mk = (recentOf, { nullP = null, nodes = N, patch = null } = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi') }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        if (nullP !== null) {
            st.score = { ...st.score, ladder1: { ...st.score.ladder1, nullP } }
        }
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthSM' }), 'utf8')
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        //每個節點一個相異之單臂(各層之「其中有內容者」之和 = 有內容且未否決之節點數)
        let arms = P.selectable.map((a) => a.id)
        assert(arms.length >= nodes.length, `鑑別前提: 可選臂數 ≥ 節點數(${arms.length})`)
        let ids = {}
        for (let x of nodes) {
            let spec = { arms: [arms[x.k - 1]], base: x.base ? ids[x.base] : null }
            let id = P.idOf(spec)
            ids[x.k] = id
            let [excess, p, share, mean] = x.b
            let ext = {
                ...(x.nc ? { ncDiag: { notContent: `執行規則非中性 ${x.k}` } } : {}),
                ...(x.sub ? { subDiag: { subset: '子集甲' } } : {}),
            }
            let rv = recentOf(x)
            if (rv !== undefined) {
                ext.nullRecentAct = rv
            }
            let metrics = {
                selHash: `sel-${x.k}`,
                op: { eqYr: { mean: 20 + x.k * 1.1, min: -3 - x.k * 0.7, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v * x.k) }, monthlyOrders: { mean: 90 + x.k }, peakHold: { max: 25 + x.k } },
                null: { mean: -5 - x.k, excess: 10 + x.k, z: 2 + x.k / 10, p: 0.001 * x.k, ...(x.act ? { sigPerPick: 2 } : {}) },
                ...(x.act ? { sel: { sigPerPick: 6 } } : {}),
                nullSideAct: { excess, p, share, mean, half: 50, triggered: true },
                ext,
            }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: x.round, raw: { metrics, issues: [], ...(x.rp ? { replays: x.rp } : {}) }, score: { S: x.S, ladder: 1, flags: { vetoed: !!x.vetoed, why: [] } }, evidence: { trust: 'trusted' } })
        }
        if (patch) {
            //節點之儲存為 JSON(NaN / Infinity 存成 null), 非有限數值只能於讀出時以替身塞入; 只改 patch 所改之欄, 其餘為真實之樹
            let get0 = P.rsi.store.getNode
            P.rsi.store.getNode = (nid) => patch(get0(nid))
        }
        P.writeBoard()
        let rd = (f) => fs.readFileSync(path.join(st.rsi.root, f), 'utf8')
        return { P, ids, arms, map: rd('SEARCH_MAP.md'), board: rd('ARMS_BOARD.md') }
    }
    let id8 = (x, k) => x.ids[k].slice(0, 8)
    //lineOf, 譜系之該節點之列; sum6, §2 各層之「其中有內容者」之和; gaugeOf, §1 該輪之量尺與「截至該輪『有內容』之最高 S」
    let lineOf = (x, k) => x.map.split('\n').find((l) => new RegExp(`^ *- \`${id8(x, k)}\` `).test(l)) || ''
    let sum6 = (x) => {
        let sec = x.map.split('## 2. 各層之覆蓋')[1].split('## 3.')[0]
        return sec.split('\n').filter((l) => /^\| [A-Z] /.test(l)).reduce((s, l) => s + Number(l.split('|')[6].trim()), 0)
    }
    let roundRow = (x, r) => (x.map.split('\n').find((l) => l.startsWith(`| r00${r} |`)) || '').split('|').map((s) => s.trim())
    let nContentOf = (x) => Number((/有內容之節點 (\d+) 個/.exec(x.map) || [])[1])
    let boardCompCell = (x, k) => {
        let ls = x.board.split('\n')
        let head = ls.find((l) => l.startsWith('| 節點 | 臂 |')).split('|').map((s) => s.trim())
        let ci = head.indexOf('組成對照之超額 / p / 可重現')
        let row = ls.find((l) => l.startsWith(`| \`${x.ids[k]}\` |`))
        return { cell: row.split('|')[ci].trim(), nCol: row.split('|').length, nHead: head.length }
    }
    let MARK = '活躍度定義不一致'
    //改前之原文(1.0.33 之 writeSearchMap 之說明一列; 門檻 0.05)
    let DESC0 = '**「有內容」**= 組成對照(同側同活躍度虛無)之超額 > 0、p ≤ 0.05,且組成可重現之比例 < 80%(扣掉「方向 × 活躍度」後仍贏過隨機);未被否決。擴充診斷自述「組成對照不是挑選內容之量」之成品(例:執行規則非中性且本身帶來大增益者,其組成對照共用該規則)不計入,譜系於其組成對照後註明理由。**「可信」**= 做夢審計為 trusted。'

    it('④ 整棵樹皆無近期版之值(不帶此鍵、error、缺 p、缺 side、非數值、null、非物件):搜尋地圖與看板之全文與不帶此鍵者逐字相同;說明一列與譜系之列為改前原文;有內容之計數同改前之判準', () => {
        let x0 = mk(() => undefined)
        //④ 說明一列 = 改前原文(字面值)
        assert(x0.map.split('\n').includes(DESC0), '說明一列與改前逐字相同')
        assert(!x0.map.includes(MARK) && !x0.board.includes(MARK) && !x0.map.includes('nullRecentAct') && !x0.board.includes('nullRecentAct'), '無標記、無新增句')
        //④ 改前之判準(內建版之超額 > 0、p ≤ 0.05、可重現 < 0.8、未自述 notContent)= 節點 1、2、5、7、9;§4 之計數另去否決 ⇒ 1、2、5、9
        assert.equal(nContentOf(x0), 4)
        assert.equal(sum6(x0), 4, '各層之「其中有內容者」之和')
        for (let k of [1, 2, 5, 7, 9]) {
            assert(lineOf(x0, k).includes(';**有內容**'), `節點 ${k} 標有內容`)
        }
        for (let k of [3, 4, 6, 8]) {
            assert(!lineOf(x0, k).includes('**有內容**'), `節點 ${k} 無有內容`)
        }
        //譜系之列之字面值(改前之格式): 根節點與有起點者各一列
        assert.equal(lineOf(x0, 1), `- \`${id8(x0, 1)}\` ${x0.arms[0]}(r001;探索;S 40.1;組成對照 12.3 / p 0.0154;trusted;**有內容**)〔未歸類〕`)
        assert.equal(lineOf(x0, 9), `  - \`${id8(x0, 9)}\` ${x0.arms[8]}(r002;探索;S 42.4;組成對照 9.9 / p 0.02;trusted;**有內容**;相對起點 ΔS +2.3、Δ超額 -2.4)〔未歸類〕`)
        assert.equal(lineOf(x0, 7), `- \`${id8(x0, 7)}\` ${x0.arms[6]}(r001;探索;S 60.6;組成對照 15.5 / p 0.011;trusted;否決;**有內容**)〔未歸類〕`)
        //量尺: 第 1 輪 = 節點 1(S 40.1;改前之判準下為有內容且可信之最高者)
        assert(roundRow(x0, 1)[5].startsWith(`\`${id8(x0, 1)}\`:40.1`), roundRow(x0, 1)[5])
        assert(x0.map.includes(`其中 2 個屬此子集`), '子集: 節點 1、2')
        //看板之組成對照一欄(改前之格式)
        assert.equal(boardCompCell(x0, 1).cell, '12.3 / 0.0154 / 31%')
        assert.equal(boardCompCell(x0, 8).cell, '11.1 / 0.014 / 27% ※')
        //④ 無值之各形 ⇒ 兩檔之全文與不帶此鍵者逐字相同(合成資料之近期版之值皆設為「若被採用即會改變判定」者: 超額為負、p 為 0.9)
        let forms = [
            ['error', () => ({ error: '診斷拋錯', side: { excess: -9.9, p: 0.9 } })],
            ['缺 p', () => ({ side: { excess: -9.9 } })],
            ['缺 excess', () => ({ side: { p: 0.9 } })],
            ['缺 side', () => ({ text: '無 side' })],
            ['side 為 null', () => ({ side: null })],
            ['非數值(字串)', () => ({ side: { excess: '-9.9', p: '0.9' } })],
            ['非數值(null;JSON 之 NaN / Infinity 即此)', () => ({ side: { excess: null, p: 0.9 } })],
            ['值為 null', () => null],
            ['非物件', () => 'x'],
        ]
        for (let [name, f] of forms) {
            let x = mk(f)
            //節點 id 與入樹之次序相同 ⇒ 全文可直接比
            assert.deepEqual(x.ids, x0.ids, '鑑別前提: 節點 id 相同')
            assert.equal(x.map, x0.map, `搜尋地圖(${name})`)
            assert.equal(x.board, x0.board, `看板(${name})`)
        }
    })

    it('①②③⑤ 有近期版之值:兩者皆過照計;一過一不過(兩方向)不計入有內容、量尺、子集、各層之覆蓋,並於譜系與看板標「活躍度定義不一致」;皆不過不標;邊界(超額恰為 0、p 恰為門檻);否決與 notContent 之排除不受影響', () => {
        let x = mk((n) => (n.r ? { text: '近期版', side: { excess: n.r[0], p: n.r[1], z: 1 + n.k / 10 } } : undefined))
        //③ 兩者皆過 ⇒ 照計: 節點 2、5(p 恰為門檻)、9(無近期版之值 ⇒ 照現行)
        for (let k of [2, 5, 9]) {
            assert(lineOf(x, k).includes(';**有內容**') && !lineOf(x, k).includes(MARK), `節點 ${k}: ${lineOf(x, k)}`)
        }
        //② 一過一不過 ⇒ 不計入、譜系標記(兩版之判定與近期版之數值)
        assert(lineOf(x, 1).includes(`組成對照 12.3 / p 0.0154(${MARK} —— 內建版過、近期活躍度版不過:近期版之超額 -2.4 / p 0.41);trusted`) && !lineOf(x, 1).includes('**有內容**'), lineOf(x, 1))
        assert(lineOf(x, 3).includes(`組成對照 6.1 / p 0.08(${MARK} —— 內建版不過、近期活躍度版過:近期版之超額 7.7 / p 0.01);trusted`) && !lineOf(x, 3).includes('**有內容**'), lineOf(x, 3))
        //②⑤ 被否決者照標(標記是量之事實), 仍不計
        assert(lineOf(x, 7).includes(`(${MARK} —— 內建版過、近期活躍度版不過:近期版之超額 -0.6 / p 0.33);trusted;否決`) && !lineOf(x, 7).includes('**有內容**'), lineOf(x, 7))
        //③ 皆不過 ⇒ 無內容、不標(節點 4: 兩版之超額皆恰為 0; 節點 6: 可重現恰為 0.8)
        for (let k of [4, 6]) {
            assert(!lineOf(x, k).includes(MARK) && !lineOf(x, k).includes('**有內容**'), `節點 ${k}: ${lineOf(x, k)}`)
        }
        //⑤ notContent 者: 既有之註記照列、不另標、不計
        assert(lineOf(x, 8).includes('(不計為挑選內容 —— ncDiag: 執行規則非中性 8)') && !lineOf(x, 8).includes(MARK) && !lineOf(x, 8).includes('**有內容**'), lineOf(x, 8))
        //② 不計入「有內容」與量尺、子集、各層之覆蓋
        assert.equal(nContentOf(x), 3, '有內容之節點 = 2、5、9')
        assert.equal(sum6(x), 3)
        assert(roundRow(x, 1)[5].startsWith(`\`${id8(x, 2)}\`:35.2`), `第 1 輪之量尺為節點 2(節點 1 不一致): ${roundRow(x, 1)[5]}`)
        assert(roundRow(x, 1)[6].includes(`35.2(\`${id8(x, 2)}\`)`), `第 1 輪「截至該輪有內容之最高 S」: ${roundRow(x, 1)[6]}`)
        assert(roundRow(x, 2)[5].startsWith(`\`${id8(x, 9)}\`:42.4`), roundRow(x, 2)[5])
        assert(x.map.includes('其中 1 個屬此子集') && x.map.includes(`S 最高 \`${id8(x, 2)}\``), '子集: 只節點 2(節點 1 不一致)')
        //④ 說明之新增句: 樹上有值之節點 8 個、一過一不過者 3 個(1、3、7)
        assert(x.map.includes('不計入,譜系於其組成對照後註明理由。成品另有近期活躍度版之組成對照(擴充診斷 `nullRecentAct` 之 `side`;樹上 8 個節點有其值)者,另須其超額 > 0、p ≤ 0.05:') &&
            x.map.includes('一過一不過者(3 個)於譜系標「活躍度定義不一致」,不計入「有內容」與量尺。**「可信」**= 做夢審計為 trusted。'), x.map.split('\n').find((l) => l.startsWith('**「有內容」**')))
        //② 看板: 組成對照一欄之末標記(該欄之其餘不變)、表前一段列兩版之判定; 欄數不變
        for (let [k, cell] of [[1, `12.3 / 0.0154 / 31% ${MARK}`], [3, `6.1 / 0.08 / 22% ${MARK}`], [7, `15.5 / 0.011 / 12% ${MARK}`], [2, '8.7 / 0.03 / 52%'], [4, '0.0 / 0.012 / 15%'], [5, '3.3 / 0.05 / 44%'], [6, '4.4 / 0.021 / 80%'], [8, '11.1 / 0.014 / 27% ※'], [9, '9.9 / 0.02 / 36%']]) {
            let c = boardCompCell(x, k)
            assert.equal(c.cell, cell, `看板之節點 ${k}`)
            assert.equal(c.nCol, c.nHead, '欄數不變')
        }
        let legend = x.board.split('\n').find((l) => l.startsWith(`組成對照一欄標「${MARK}」者:`)) || ''
        assert(legend.includes('門檻同為超額 > 0、p ≤ 0.05') && legend.includes(`\`${id8(x, 1)}\`(內建版過、近期活躍度版不過:近期版之超額 -2.4 / p 0.41)`) &&
            legend.includes(`\`${id8(x, 3)}\`(內建版不過、近期活躍度版過:近期版之超額 7.7 / p 0.01)`) && legend.includes(`\`${id8(x, 7)}\`(內建版過、近期活躍度版不過:近期版之超額 -0.6 / p 0.33)`), legend)
        for (let k of [2, 4, 5, 6, 8, 9]) {
            assert(!legend.includes(id8(x, k)), `表前不列節點 ${k}`)
        }
        //鑑別前提: 同一棵樹改為無近期版之值時, 節點 1 為有內容且為第 1 輪之量尺(上一案), 本案之差異來自近期版
    })

    it('① 門檻取自 settings.score.ladder1.nullP(與內建版同一個值;非 0.05 時)', () => {
        //節點 a: 內建 p 0.07、近期 p 0.09 ⇒ 門檻 0.1 下兩者皆過; 節點 b: 內建 p 0.02、近期 p 0.08 ⇒ 門檻 0.1 下皆過、0.05 下為一過一不過
        let nodes = [
            { k: 1, b: [5.5, 0.07, 0.2, 1.5], S: 33.3, round: 1, r: [4.4, 0.09] },
            { k: 2, b: [6.6, 0.02, 0.3, 2.5], S: 22.2, round: 1, r: [3.3, 0.08] },
        ]
        let rv = (n) => ({ side: { excess: n.r[0], p: n.r[1] } })
        let x = mk(rv, { nullP: 0.1, nodes })
        assert.equal(nContentOf(x), 2, '門檻 0.1 ⇒ 兩者皆有內容')
        assert(!lineOf(x, 1).includes(MARK) && !lineOf(x, 2).includes(MARK) && !x.board.includes(MARK), '無不一致之節點 ⇒ 譜系與看板皆不標')
        assert(x.map.includes('另須其超額 > 0、p ≤ 0.1:') && x.map.includes('一過一不過者(0 個)'))
        //對照: 參考設定之門檻 0.05 ⇒ 節點 a 皆不過、節點 b 一過一不過
        let y = mk(rv, { nodes })
        assert.equal(nContentOf(y), 0)
        assert(lineOf(y, 2).includes(`(${MARK} —— 內建版過、近期活躍度版不過:近期版之超額 3.3 / p 0.08)`) && !lineOf(y, 1).includes(MARK))
    })

    it('⑥ 量尺之「挑選內容」與看板之「正本與重放之均」取近期版之超額: 與「有內容」同一個取值函數 —— 超額須為有限數值(只用超額、不要求 p); 非有限(NaN、±Infinity)與帶 error 者視為無值;有限值之輸出不變', () => {
        //規格(規則 R-REC-38 之收斂; Gitea #198 之另見 1): 兩處原只核「超額為 number」, NaN / Infinity 亦被採用(⇒ 均值為 NaN); 現與 recentSideOf 共用取值(超額為有限數值), 非有限者視為無值(取內建之組成對照)
        //  合成: 單一節點(內建版過、近期版過 ⇒ 為量尺之最高者; 選集之每隻訊號數 6 ≥ 2 × 2 ⇒ 挑選內容用近期版), 2 次重放(S 38.0 / 42.2、組成對照 2.2 / 4.4、近期版 3.3 / 6.1; 各值相異)
        //  期望: 近期版取用 ⇒ 挑選內容 = (4.5 + 3.3 + 6.1) / 3 = 4.6(3 抽); 看板 = 40.1;6.3 / 4.6(S 之均 40.1、組成對照之均 (12.3 + 2.2 + 4.4) / 3 = 6.3)
        //        近期版無值 ⇒ 挑選內容改取內建 = (12.3 + 2.2 + 4.4) / 3 = 6.3(3 抽); 看板之近期版之均只含重放 = (3.3 + 6.1) / 2 = 4.7
        //  鑑別前提: 取用與不取用之結果不同(4.6 與 6.3、4.6 與 4.7)
        let node = { k: 1, b: [12.3, 0.0154, 0.31, 3.1], S: 40.1, round: 1, act: true, rp: [{ S: 38.0, comp: 2.2, recent: 3.3 }, { S: 42.2, comp: 4.4, recent: 6.1 }] }
        let YES = { gauge: '挑選內容 4.6(近期活躍度版;3 抽之均)', board: '40.1;6.3 / 4.6' }
        let NO = { gauge: '挑選內容 6.3(內建組成對照;3 抽之均)', board: '40.1;6.3 / 4.7' }
        let run = (recentOf, patch = null) => mk(recentOf, { nodes: [node], patch })
        let see = (x) => ({ gauge: roundRow(x, 1)[5], board: x.board.split('\n').find((l) => l.startsWith(`| \`${x.ids[1]}\` |`)) || '', content: nContentOf(x) })
        let eq = (x, e, why) => {
            let s = see(x)
            assert(s.gauge.includes(e.gauge) && s.board.includes(e.board), `${why}: ${s.gauge} ‖ ${s.board}`)
            assert(!x.map.includes('NaN') && !x.board.includes('NaN') && !x.map.includes('Infinity') && !x.board.includes('Infinity'), `${why}: 不得出現 NaN / Infinity`)
        }
        //有限值: 近期版取用(含超額為負、0 之邊界以外之一般值); 只給超額不給 p 者(「有內容」之判定視為無值)之挑選內容與看板仍取其超額(既有行為, 逐位不變)
        let fin = run(() => ({ side: { excess: 4.5, p: 0.02 } }))
        eq(fin, YES, '有限(超額與 p 皆有)')
        assert.equal(see(fin).content, 1, '有內容(兩版皆過)')
        let noP = run(() => ({ side: { excess: 4.5 } }))
        eq(noP, YES, '有限(缺 p: 只用超額)')
        assert.equal(see(noP).content, 1, '缺 p ⇒ 「有內容」視為無近期版之值 ⇒ 依內建版(過)')
        let small = run(() => ({ side: { excess: 0.3, p: 0.02 } }))
        assert(see(small).gauge.includes('挑選內容 3.2(近期活躍度版;3 抽之均)') && see(small).board.includes('40.1;6.3 / 3.2'), `超額 0.3(有限) ⇒ 取用: ${see(small).gauge}`) // (0.3 + 3.3 + 6.1) / 3 = 3.23
        //非有限(只能於讀出時塞入): 視為無值 ⇒ 與「超額為 null(JSON 之 NaN / Infinity 之存法)」之樹逐字相同, 且取內建之組成對照
        let asNull = run(() => ({ side: { excess: null, p: 0.02 } }))
        eq(asNull, NO, '超額為 null(無值)')
        for (let [name, v] of [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]]) {
            let patch = (n) => {
                n.raw.metrics.ext.nullRecentAct.side.excess = v
                return n
            }
            let x = run(() => ({ side: { excess: 4.5, p: 0.02 } }), patch)
            eq(x, NO, `超額為 ${name}`)
            assert.equal(x.map, asNull.map, `${name}: 搜尋地圖與無值者逐字相同`)
            assert.equal(x.board, asNull.board, `${name}: 看板與無值者逐字相同`)
        }
        //帶 error 者(核心不會同時給 error 與 side; 與 recentSideOf 同一口徑 ⇒ 無值)
        eq(run(() => ({ error: '診斷拋錯', side: { excess: 4.5, p: 0.02 } })), NO, '帶 error')
        //非數值(字串)、缺 excess、缺 side: 原即無值, 不變
        eq(run(() => ({ side: { excess: '4.5', p: 0.02 } })), NO, '字串')
        eq(run(() => ({ side: { p: 0.02 } })), NO, '缺 excess')
        eq(run(() => ({ text: '無 side' })), NO, '缺 side')
        //鑑別前提
        assert.notEqual(YES.gauge, NO.gauge)
        assert.notEqual(YES.board, NO.board)
    })
})
