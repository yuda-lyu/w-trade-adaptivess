import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { FD_ROOT } from './tools/synthLedger.mjs'


//測試之成敗不得隨機器之負載而變: 以參考設定(套件根之 settings.json)組合成之設定寫給子行程者, 須關閉資源閘(參考設定之 resources 依全機 CPU 與記憶體等待)
//  判定(靜態): 測試檔內讀參考設定並展開(...base)、或讀入後改寫再寫出 settings.json 者, 同檔去掉區塊註解與行註解後須寫明 resources: {} 或 st.resources = {}
describe('測試之合成設定不沿用參考設定之資源閘', function () {
    let dir = path.join(FD_ROOT, 'test')
    let files = fs.readdirSync(dir).filter((f) => /\.test\.mjs$/.test(f) && f !== 'unit-testResources.test.mjs')
    let readsRef = (s) => /JSON\.parse\(fs\.readFileSync\(path\.join\(FD_ROOT, 'settings\.json'\)/.test(s)
    let writesChild = (s) => /fs\.writeFileSync\(path\.join\([^)]*'settings\.json'\)/.test(s)
    //codeOnly, 去掉字串、區塊註解(含起於行中者)與行註解(字串內之斜線與星號不是註解); 註解掉或寫在字串內之寫法不算關閉
    let codeOnly = (s) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    let gateOff = (s) => {
        let c = codeOnly(s)
        return /\bresources: \{\}/.test(c) || /\.resources = \{\}/.test(c)
    }

    it('判定本身:讀參考設定且寫給子行程而未關閉資源閘者被指出;已關閉、只讀不寫者不指出', () => {
        let rd = 'let base = JSON.parse(fs.readFileSync(path.join(FD_ROOT, \'settings.json\'), \'utf8\'))\n'
        let wr = 'fs.writeFileSync(path.join(root, \'settings.json\'), JSON.stringify(x), \'utf8\')\n'
        assert.equal(readsRef(rd) && writesChild(wr), true)
        assert.equal(gateOff(rd + wr), false, '未關閉')
        assert.equal(gateOff(`${rd}let x = { ...base, resources: {} }\n${wr}`), true)
        assert.equal(gateOff(`${rd}st.resources = {}\n${wr}`), true)
        assert.equal(writesChild(rd), false, '只讀不寫')
        //註解掉之寫法不算關閉
        assert.equal(gateOff(`${rd}//resources: {},\n${wr}`), false, '行註解')
        assert.equal(gateOff(`${rd}    // st.resources = {}\n${wr}`), false, '縮排之行註解')
        assert.equal(gateOff(`${rd}/*\nresources: {},\n*/\n${wr}`), false, '區塊註解內')
        assert.equal(gateOff(`${rd}/* resources: {}, */\n${wr}`), false, '單行之區塊註解')
        assert.equal(gateOff(`${rd}/* 說明 */\nlet x = { ...base, resources: {} }\n${wr}`), true, '區塊註解之後之程式碼照認')
        //區塊註解起於行中、行尾之行註解
        assert.equal(gateOff(`${rd}let x = { ...base, a: 1, /*\nresources: {},\n*/ }\n${wr}`), false, '起於行中之區塊註解')
        assert.equal(gateOff(`${rd}let x = { ...base } // resources: {}\n${wr}`), false, '行尾之行註解')
        assert.equal(gateOff(`${rd}let x = { ...base, a: 1 /* resources: {} */ }\n${wr}`), false, '行中之單行區塊註解')
        //字串內之註解樣式不是註解: 其後之程式碼照認
        assert.equal(gateOff(`${rd}let g = 'test/*.test.mjs'\nlet x = { ...base, resources: {} }\nlet h = 'a*/b'\n${wr}`), true, '字串內之區塊註解樣式')
        assert.equal(gateOff(`${rd}let u = 'http://a'; let x = { ...base, resources: {} }\n${wr}`), true, '字串內之行註解樣式')
        //寫在字串內之寫法不算關閉
        assert.equal(gateOff(`${rd}let s = 'resources: {}'\n${wr}`), false, '字串內之寫法')
    })

    it('現行測試檔:以參考設定組合子行程之設定者皆已關閉資源閘', () => {
        let hit = files.filter((f) => {
            let s = fs.readFileSync(path.join(dir, f), 'utf8'); return readsRef(s) && writesChild(s)
        })
        assert(hit.length >= 2, `應至少涵蓋既知之檔(實得 ${hit.join('、')})`)
        let bad = hit.filter((f) => !gateOff(fs.readFileSync(path.join(dir, f), 'utf8')))
        assert.deepEqual(bad, [])
    })
})
