import rollupFiles from 'w-package-tools/src/rollupFiles.mjs'


let fdSrc = './src'
let fdTar = './dist'


//external與globals之盤點原則:
//1. 本套件src之node內建模組一律以無前綴引用(fs、path、os、url、crypto、child_process、module), 與自有套件同一寫法; rollup之external與globals以import字串逐字比對
//2. 自有套件(w-recursi、w-trade-backtest)以其src深層路徑引用, 列為external由使用端安裝(與package.json之dependencies一致)
//3. runin須為nodejs: 本套件僅能於nodejs執行(fs、child_process)
//4. dist之限制(行為不改, 僅記錄): 命令列程式(src/cli/*.mjs)與工具(src/tools/*.mjs)是「執行即動作」之指令稿, 由專案根之進入檔以ESM深層路徑載入, 不在聚合入口之import圖內, 故不隨dist打包;
//   以import.meta.url定位套件內檔案者(src/domain/texts.mjs之程式夾位置、src/tools/initProject.mjs之套件夾、src/arsi/dispatchers.mjs之createRequire)於UMD內之行為未驗證 ——
//   實務上請一律以ESM深層路徑取用(w-trade-adaptivess/src/WTradeAdaptivess.mjs, 套件不設exports)
//盤點方式: 自src/WTradeAdaptivess.mjs靜態追蹤import圖, 裸import為下列node內建模組與兩個自有套件之src深層路徑; 新增依賴後須重盤


rollupFiles({
    fns: 'WTradeAdaptivess.mjs',
    fdSrc,
    fdTar,
    nameDistType: 'kebabCase',
    runin: 'nodejs',
    globals: {

        //node內建模組
        'path': 'path',
        'fs': 'fs',
        'os': 'os',
        'url': 'url',
        'crypto': 'crypto',
        'child_process': 'child_process',
        'module': 'module',

    },
    external: [

        //node內建模組
        'path',
        'fs',
        'os',
        'url',
        'crypto',
        'child_process',
        'module',

        //自有套件(使用端安裝; 以src深層路徑引用)
        /^w-recursi\//,
        /^w-trade-backtest\//,

    ],
})


//node toolg/gDistRollup.mjs
