interface CarBranding {
  manufacturer: string;
  title: string;
  showBackButton: boolean;
  logo: string | null;
  rightHandDrive: boolean;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id} element`);
  return value as T;
}

/** Fit a user-supplied image into a transparent square PNG for the CarPlay icon. */
export async function prepareCarLogo(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPG or WebP image.');
  }
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose an image no larger than 5 MB.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Could not read this image. Try another PNG, JPG or WebP.');
  }
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096) throw new Error('Choose an image no larger than 4096 × 4096 pixels.');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the logo in this browser.');
    const scale = 256 / Math.max(bitmap.width, bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (256 - width) / 2, (256 - height) / 2, width, height);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

export function setupCarSettings(token: string): void {
  const panel = element<HTMLDialogElement>('car-panel');
  const form = element<HTMLFormElement>('car-form');
  const fields = element<HTMLFieldSetElement>('car-fields');
  const apply = element<HTMLButtonElement>('btn-car-apply');
  const manufacturer = element<HTMLInputElement>('car-manufacturer');
  const driverSide = element<HTMLSelectElement>('car-driver-side');
  const title = element<HTMLInputElement>('car-button-title');
  const showBack = element<HTMLInputElement>('car-show-back');
  const upload = element<HTMLInputElement>('car-logo');
  const preview = element<HTMLImageElement>('car-preview-logo');
  const status = element<HTMLParagraphElement>('car-status');
  let logo: string | null = null;
  let busy = false;
  let loaded = false;

  const setBusy = (value: boolean): void => {
    busy = value;
    fields.disabled = value || !loaded;
    apply.disabled = value || !loaded || !token;
  };
  const setStatus = (message: string, error = false): void => {
    status.textContent = message;
    status.dataset.error = String(error);
  };
  const updatePreview = (): void => {
    preview.hidden = !logo;
    if (logo) preview.src = logo;
    else preview.removeAttribute('src');
    element('car-preview-default').toggleAttribute('hidden', Boolean(logo));
    element('car-preview-title').textContent = title.value.trim() || 'PlayPort';
    element('car-preview-hidden').hidden = showBack.checked;
    panel.querySelector<HTMLElement>('.car-preview')!.dataset.visible = String(showBack.checked);
  };

  const refresh = async (): Promise<void> => {
    loaded = false;
    setBusy(true);
    setStatus('Loading…');
    try {
      const response = await fetch(`/api/car?token=${encodeURIComponent(token)}`);
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const settings = await response.json() as CarBranding;
      manufacturer.value = settings.manufacturer;
      driverSide.value = settings.rightHandDrive ? 'right' : 'left';
      title.value = settings.title;
      showBack.checked = settings.showBackButton;
      logo = settings.logo;
      upload.value = '';
      updatePreview();
      loaded = true;
      setStatus('Car settings are saved on the server.');
    } catch {
      setStatus('Could not load car settings. Check your viewer link and server connection, then reopen Car.', true);
    } finally {
      setBusy(false);
    }
  };

  element('btn-car').addEventListener('click', () => {
    panel.showModal();
    if (busy) return;
    if (!token) {
      loaded = false;
      setBusy(false);
      setStatus('Open the viewer link printed by the server to change car settings.', true);
      return;
    }
    void refresh();
  });
  element('btn-car-close').addEventListener('click', () => panel.close());
  title.addEventListener('input', updatePreview);
  showBack.addEventListener('change', updatePreview);
  element('btn-car-logo-reset').addEventListener('click', () => {
    logo = null;
    upload.value = '';
    updatePreview();
    setStatus('Default icon selected. Apply to save.');
  });
  upload.addEventListener('change', async () => {
    const file = upload.files?.[0];
    if (!file || busy) return;
    setBusy(true);
    setStatus('Preparing logo…');
    try {
      logo = await prepareCarLogo(file);
      showBack.checked = true;
      updatePreview();
      setStatus('Logo ready. Apply to save.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not prepare the logo.', true);
    } finally {
      upload.value = '';
      setBusy(false);
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !loaded || !token || !form.reportValidity()) return;
    const settings: CarBranding = {
      manufacturer: manufacturer.value.trim(), title: title.value.trim(), showBackButton: showBack.checked, logo,
      rightHandDrive: driverSide.value === 'right',
    };
    setBusy(true);
    setStatus('Applying…');
    try {
      const response = await fetch(`/api/car?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
      manufacturer.value = settings.manufacturer;
      title.value = settings.title;
      updatePreview();
      setStatus('Saved. Reconnecting CarPlay…');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not apply car settings.', true);
    } finally {
      setBusy(false);
    }
  });
}
