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

// 標出訪客的作業系統
const ua = navigator.userAgent
const os = /Windows/.test(ua) ? 'win' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Linux/.test(ua) && !/Android/.test(ua) ? 'linux' : null
if (os) {
  document.querySelector(`.dl-list [data-os="${os}"]`)?.classList.add('me')
  const label = { win: 'Windows', mac: 'macOS', linux: 'Linux' }[os]
  const main = document.getElementById('dl-main')
  if (main) main.firstChild.textContent = `免費下載 ${label} 版 `
}

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
