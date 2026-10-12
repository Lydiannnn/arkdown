(() => {
  'use strict';
  const root=document.documentElement;
  const system=window.matchMedia('(prefers-color-scheme: dark)');
  let preference=null;
  try{preference=localStorage.getItem('arkdown-handbook-theme');}catch{}
  const applyTheme=()=>{root.dataset.theme=preference||(system.matches?'dark':'light');};
  applyTheme();
  system.addEventListener?.('change',()=>{if(!preference)applyTheme();});
  document.addEventListener('DOMContentLoaded',()=>{
    const $=s=>document.querySelector(s);
    const search=$('.search-dialog'),input=$('#search-input'),results=$('.search-results'),status=$('.search-status');
    const sidebar=$('#sidebar'),overlay=$('.nav-overlay'),navOpen=$('[data-nav-open]');
    const mobile=window.matchMedia('(max-width: 767px)');
    const theme=$('[data-theme-toggle]');
    const themeLabel=()=>{theme.setAttribute('aria-label',root.dataset.theme==='dark'?'切换到浅色模式':'切换到深色模式');theme.title=theme.getAttribute('aria-label');};
    themeLabel();
    theme.addEventListener('click',()=>{preference=root.dataset.theme==='dark'?'light':'dark';applyTheme();themeLabel();try{localStorage.setItem('arkdown-handbook-theme',preference);}catch{}});
    function setDrawer(open){sidebar.classList.toggle('nav-open',open);overlay.hidden=!open;navOpen.setAttribute('aria-expanded',String(open));document.body.style.overflow=open?'hidden':'';sidebar.inert=mobile.matches&&!open;$('.page-shell').inert=open;$('.topbar').inert=open;if(open){sidebar.setAttribute('role','dialog');sidebar.setAttribute('aria-modal','true');$('[data-nav-close]').focus();}else{sidebar.removeAttribute('role');sidebar.removeAttribute('aria-modal');}}
    setDrawer(false);
    navOpen.addEventListener('click',()=>setDrawer(true));
    const closeDrawer=()=>{setDrawer(false);navOpen.focus();};
    $('[data-nav-close]').addEventListener('click',closeDrawer);overlay.addEventListener('click',closeDrawer);
    mobile.addEventListener('change',()=>setDrawer(false));
    sidebar.addEventListener('keydown',e=>{if(!sidebar.classList.contains('nav-open'))return;if(e.key==='Escape'){e.preventDefault();closeDrawer();}if(e.key==='Tab'){const els=[...sidebar.querySelectorAll('a,button')].filter(el=>el.getClientRects().length);const first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    function renderSearch(){const terms=input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);const all=window.guideIndex||[];const matched=terms.length?all.map(r=>({...r,score:terms.reduce((n,t)=>n+(r.title.toLowerCase().includes(t)?5:0)+(r.chapter.toLowerCase().includes(t)?2:0),0)})).filter(r=>terms.every(t=>r.text.toLowerCase().includes(t))).sort((a,b)=>b.score-a.score):all.filter(r=>['start-open','saving-draft','settings-background','ai-start'].some(id=>r.url.endsWith('#'+id)));
      status.textContent=terms.length?(matched.length?`找到 ${matched.length} 个相关小节`:'没有找到相关内容，试试“保存”“背景”或“翻译”。'):'常用内容 · 输入关键词搜索全部说明';
      results.replaceChildren(...matched.map(r=>{const a=document.createElement('a');a.className='search-result';a.href=r.url;const small=document.createElement('small');small.textContent=r.chapter;const strong=document.createElement('strong');strong.textContent=r.title;const p=document.createElement('p');p.textContent=r.summary;a.append(small,strong,p);return a;}));
    }
    results.addEventListener('click',e=>{if(e.target.closest('a'))search.close();});
    function openSearch(){if(sidebar.classList.contains('nav-open'))setDrawer(false);search.showModal();input.value='';renderSearch();input.focus();}
    $('[data-search-open]').addEventListener('click',openSearch);$('[data-search-close]').addEventListener('click',()=>search.close());input.addEventListener('input',renderSearch);
    search.addEventListener('click',e=>{if(e.target===search){const rect=search.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)search.close();}});
    input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();results.querySelector('a')?.focus();}if(e.key==='Enter')results.querySelector('a')?.click();});
    results.addEventListener('keydown',e=>{const links=[...results.querySelectorAll('a')];const i=links.indexOf(document.activeElement);if(e.key==='ArrowDown'){e.preventDefault();links[Math.min(i+1,links.length-1)]?.focus();}if(e.key==='ArrowUp'){e.preventDefault();if(i===0)input.focus();else links[i-1]?.focus();}});
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(search.open)search.close();else openSearch();}});
    let toastTimer;
    const notify=message=>{clearTimeout(toastTimer);$('.toast').hidden=false;$('.toast').textContent=message;toastTimer=setTimeout(()=>{$('.toast').hidden=true;},2500);};
    for(const button of document.querySelectorAll('[data-copy]'))button.addEventListener('click',async()=>{const text=button.closest('.code-example').querySelector('code').textContent;try{await navigator.clipboard.writeText(text);notify('示例已复制');}catch{const area=document.createElement('textarea');area.value=text;area.setAttribute('aria-label','复制示例');document.body.append(area);area.select();const copied=document.execCommand('copy');area.remove();button.focus();notify(copied?'示例已复制':'请选中示例文字手动复制');}});
    const imageDialog=$('.image-dialog');
    for(const button of document.querySelectorAll('[data-zoom]'))button.addEventListener('click',()=>{const original=button.querySelector('img');const img=imageDialog.querySelector('img');img.src=original.src;img.alt=original.alt;imageDialog.showModal();});
    $('[data-image-close]').addEventListener('click',()=>imageDialog.close());
    imageDialog.addEventListener('click',e=>{if(e.target===imageDialog)imageDialog.close();});
    const tocLinks=[...document.querySelectorAll('.toc nav a')];
    const observed=tocLinks.map(a=>document.getElementById(a.hash.slice(1))).filter(Boolean);
    const activate=id=>tocLinks.forEach(a=>{const active=a.hash==='#'+id;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});
    if(observed.length){activate(location.hash.slice(1)||observed[0].id);const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)activate(e.target.id);},{rootMargin:'-90px 0px -55% 0px'});observed.forEach(el=>observer.observe(el));}
    window.addEventListener('hashchange',()=>activate(location.hash.slice(1)));
  },{once:true});
})();
