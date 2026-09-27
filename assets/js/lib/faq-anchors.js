/**
 * A link to one answer on the help page, for handing to somebody.
 *
 * "Read the bit about offline downloads" is a scroll through thirty closed
 * questions; a link that opens the one answer is the thing worth sending, from
 * support replies especially. Every question in faq.html carries a permanent
 * id for it - in the markup, so the link works with JavaScript off and from
 * other pages - and this adds the button that copies one.
 *
 * The ids are URLs other people keep. test/faq-anchors.test.mjs fails if one
 * goes missing or two collide, and checks every link to faq.html#... in the
 * repository still lands on something.
 */

import { shareableURL } from './share.js';
import { icons } from './icons.js';

/**
 * The address to hand over for an id on the help page.
 *
 * Built by shareableURL, like every link that leaves the device: inside the
 * app the page runs at capacitor://localhost, which opens nothing on the phone
 * it is sent to, so there the published site is used instead.
 */
export function answerLink({ id, href, protocol, site }) {
  return shareableURL({ href, protocol, site, path: 'faq.html', hash: `#${id}` });
}

/**
 * A copy-link button for every question and every section heading.
 *
 * An <a href="#id"> rather than a <button>, so it is also a plain link: a
 * right click copies it, a middle click opens it, and it still means
 * something to a screen reader listing the page's links. Clicking it copies
 * the whole address, opens the answer and puts the id in the address bar.
 *
 * Inside a <summary> the click must not also fold the answer shut. A link is
 * its own activation target, so browsers do not toggle for it, but the event
 * is stopped as well rather than left to that.
 */
export function mountFaqAnchors(root, { site, toast = () => {}, location = globalThis.location,
  history = globalThis.history, clipboard = globalThis.navigator?.clipboard,
  share = globalThis.navigator?.share?.bind(globalThis.navigator) } = {}) {
  const doc = root.ownerDocument || root;
  const targets = [
    ...[...root.querySelectorAll('.faq-item[id]')].map((item) => ({
      id: item.id, item, holder: item.querySelector(':scope > summary'), label: item.querySelector('h3')?.textContent || '',
    })),
    ...[...root.querySelectorAll('.faq-section[id]')].map((section) => ({
      id: section.id, item: null, holder: section.querySelector(':scope > h2'), label: section.querySelector('h2')?.textContent || '',
    })),
  ].filter((target) => target.holder);

  for (const { id, item, holder, label } of targets) {
    if (holder.querySelector('.faq-anchor')) continue;
    const link = doc.createElement('a');
    link.className = 'faq-anchor';
    link.href = `#${id}`;
    link.title = 'Copy a link to this';
    link.setAttribute('aria-label', `Copy a link to “${label.trim()}”`);
    link.innerHTML = icons.link;

    link.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item) item.open = true;
      // Replaced rather than pushed: copying a link is not somewhere Back
      // should have to step through.
      history?.replaceState?.(null, '', `#${id}`);

      const url = answerLink({ id, href: location.href, protocol: location.protocol, site });
      try {
        await clipboard.writeText(url);
        toast('Link copied.', { tone: 'ok', timeout: 2500 });
      } catch {
        // No clipboard - an insecure preview, or a webview that refuses it.
        // The share sheet is the next way to hand a link over, and the
        // address bar the last.
        try {
          if (!share) throw new Error('no share sheet');
          await share({ url, title: label.trim() });
        } catch (error) {
          if (error?.name === 'AbortError') return;
          toast('Could not copy it. The link to this is in the address bar.', { tone: 'error' });
        }
      }
    });

    // In a summary it sits between the question and the chevron; in a
    // heading, after the words.
    const question = holder.querySelector('h3');
    if (question) question.after(link);
    else holder.append(link);
  }
  return targets.length;
}
