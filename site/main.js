// 捲動到才淡入
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in')
        io.unobserve(e.target)
      }
    }
  },
  { threshold: 0.12 },
)
document.querySelectorAll('.reveal').forEach((el) => io.observe(el))

// 標出訪客的作業系統（三個平台都照樣顯示）
const ua = navigator.userAgent
const os = /Windows/.test(ua) ? 'win' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Linux/.test(ua) && !/Android/.test(ua) ? 'linux' : null
if (os) document.querySelector(`.dl-card[data-os="${os}"]`)?.classList.add('me')

// 下載按鈕直接連到最新版的安裝檔；查不到就留在 Releases 頁
const ASSETS = {
  win: /x64-setup\.exe$/,
  'mac-arm': /aarch64\.dmg$/,
  'mac-intel': /x64\.dmg$/,
  appimage: /\.AppImage$/,
  deb: /\.deb$/,
}
fetch('https://api.github.com/repos/craig7351/book-en/releases/latest')
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((rel) => {
    for (const a of document.querySelectorAll('[data-asset]')) {
      const asset = rel.assets.find((x) => ASSETS[a.dataset.asset].test(x.name))
      if (asset) a.href = asset.browser_download_url
    }
    const ver = document.querySelector('.dl-note .ver')
    if (ver && rel.tag_name) ver.textContent = `　·　目前版本 ${rel.tag_name}`
  })
  .catch(() => {})

// 點截圖放大
const box = document.querySelector('.lightbox')
const big = box.querySelector('img')
document.querySelectorAll('.frame img').forEach((img) =>
  img.addEventListener('click', () => {
    big.src = img.currentSrc || img.src
    big.alt = img.alt
    box.hidden = false
  }),
)
box.addEventListener('click', () => (box.hidden = true))
addEventListener('keydown', (e) => e.key === 'Escape' && (box.hidden = true))

// 介紹影片：點了才載入 YouTube 播放器
document.querySelectorAll('.video-play').forEach((btn) =>
  btn.addEventListener('click', () => {
    const f = document.createElement('iframe')
    f.src = `https://www.youtube-nocookie.com/embed/${btn.dataset.yt}?autoplay=1&rel=0`
    f.title = 'book-en 介紹影片'
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'
    f.allowFullscreen = true
    btn.replaceWith(f)
  }),
)
