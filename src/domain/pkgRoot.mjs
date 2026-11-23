import fs from 'fs'
import path from 'path'


//pkgRootOf(fromDir, name), 自 fromDir 往上找「本套件之 package.json」(其 name 為套件名)所在之夾 ⇒ 套件根之絕對路徑; 找不到回 null
//  用途(排程第 477 項 ②): 本套件打包成單檔(dist/w-trade-adaptivess.umd.js)後, 各模組之 import.meta.url 皆指向 dist 內之打包檔, 不是各原始檔之位置 ⇒
//  以檔案位置推導套件內之夾(src/domain、src; 任務書所寫之程式夾、評估器原始碼之夾)會錯(得到 dist); 改由套件根定位 ——
//  原始檔(<套件根>/src/domain/*.mjs)與打包檔(<套件根>/dist/*.js)往上找皆得同一個套件根(套件裝於 node_modules/<套件名>/ 者亦同)
//  找不到(例: 原始檔被複製到無本套件之 package.json 之處)⇒ 呼叫端依檔案位置推導(原作法)
let PKG_NAME = 'w-trade-adaptivess'
let pkgRootOf = (fromDir, name = PKG_NAME) => {
    let d = path.resolve(fromDir)
    for (;;) {
        try {
            let fp = path.join(d, 'package.json')
            if (fs.existsSync(fp) && JSON.parse(fs.readFileSync(fp, 'utf8')).name === name) {
                return d
            }
        }
        catch (err) {}
        let up = path.dirname(d)
        if (up === d) {
            return null
        }
        d = up
    }
}


export { pkgRootOf, PKG_NAME }
export default pkgRootOf
