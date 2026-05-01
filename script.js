/* ============================================================
   Axel's Trusted LLC — script.js
   Mobile nav, before/after sliders, form handling
   ============================================================ */

/* ---------- Mobile Nav ---------- */
(function () {
  const burger = document.getElementById('burger');
  const menu   = document.getElementById('mobileMenu');
  if (!burger || !menu) return;

  burger.addEventListener('click', () => {
    const isOpen = menu.classList.toggle('open');
    burger.setAttribute('aria-expanded', isOpen);
  });

  // Close menu when a link inside is clicked
  menu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      menu.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
    });
  });
})();

/* ---------- Smooth-scroll for anchor links ---------- */
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    const target = document.querySelector(this.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const navHeight = document.querySelector('.nav')?.offsetHeight || 68;
    const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 8;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

/* ---------- Before/After Sliders ---------- */
document.querySelectorAll('[data-slider]').forEach(slider => {
  const after    = slider.querySelector('.slider-wrap__after');
  const divider  = slider.querySelector('.slider-wrap__divider');
  const handle   = slider.querySelector('.slider-wrap__handle');

  // Only activate if real before/after images exist
  if (!after || !divider || !handle) return;

  let dragging = false;

  function setPosition(clientX) {
    const rect = slider.getBoundingClientRect();
    let pct = (clientX - rect.left) / rect.width;
    pct = Math.min(Math.max(pct, 0.04), 0.96);
    const pctPx = `${pct * 100}%`;
    after.style.clipPath = `inset(0 ${(1 - pct) * 100}% 0 0)`;
    divider.style.left = pctPx;
    handle.style.left  = pctPx;
  }

  // Mouse
  handle.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  window.addEventListener('mouseup',   () => { dragging = false; });
  window.addEventListener('mousemove', e => { if (dragging) setPosition(e.clientX); });

  // Touch
  handle.addEventListener('touchstart', e => { dragging = true; }, { passive: true });
  window.addEventListener('touchend',   () => { dragging = false; });
  window.addEventListener('touchmove',  e => {
    if (dragging) setPosition(e.touches[0].clientX);
  }, { passive: true });

  // Keyboard accessibility on handle
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('role', 'slider');
  handle.setAttribute('aria-label', 'Drag to compare before and after');
  handle.addEventListener('keydown', e => {
    const rect = slider.getBoundingClientRect();
    const currentLeft = parseFloat(divider.style.left || '50%') / 100;
    const step = 0.05;
    if (e.key === 'ArrowLeft')  setPosition(rect.left + (currentLeft - step) * rect.width);
    if (e.key === 'ArrowRight') setPosition(rect.left + (currentLeft + step) * rect.width);
  });
});

/* ---------- Contact Form ---------- */
(function () {
  const form = document.getElementById('contactForm');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    // If the action is still the placeholder "#", use mailto fallback
    if (form.getAttribute('action') === '#') {
      e.preventDefault();

      const name    = form.name?.value.trim()    || '';
      const phone   = form.phone?.value.trim()   || '';
      const service = form.service?.value        || '';
      const message = form.message?.value.trim() || '';

      const to = 'axelsllc22@gmail.com';
      const subject = encodeURIComponent('Quote Request — Axel\'s Trusted LLC');
      const body = encodeURIComponent(
        `Name: ${name}\nPhone: ${phone}\nService: ${service}\n\n${message}`
      );

      window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
      return;
    }

    // If a real action URL is set, let the form submit normally (Formspree, etc.)
    // Optionally show a thank-you message after submission
  });
})();

/* ---------- Active nav link on scroll ---------- */
(function () {
  const sections = document.querySelectorAll('section[id], div[id]');
  const navLinks = document.querySelectorAll('.nav__links a, .nav__mobile-menu a');
  const navHeight = document.querySelector('.nav')?.offsetHeight || 68;

  function onScroll() {
    let current = '';
    sections.forEach(section => {
      if (window.scrollY >= section.offsetTop - navHeight - 20) {
        current = section.getAttribute('id');
      }
    });

    navLinks.forEach(link => {
      link.style.color = '';
      if (link.getAttribute('href') === `#${current}`) {
        link.style.color = 'var(--amber)';
      }
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
})();
