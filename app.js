const API = window.STORE_API_URL;
const LOCAL_DEMO_MODE = !API || API.includes("PASTE_");
const FALLBACK_IMAGE = "assets/logo.png";
const DEFAULT_LALAMOVE_FORM_URL = "https://delivery.lalamove.com/forms/PH4c4ef013d6d54893b979fa6c04c447ca";
const JNT_ORDER_URL = "https://www.jtexpress.ph/appOrder";
const DEFAULT_PAYMENT_QR = {
  gcash: "assets/gcash-qr.jpg",
  unionbank: "assets/unionbank-qr.jpeg"
};

let products = [];
let categories = [];
let reviews = [];
let storeSettings = {};
let cart = JSON.parse(localStorage.getItem("cart") || "[]");
let lastOrderMessage = "";
let checkoutMode = "cart";
let buyNowItem = null;
let lastSubmittedOrder = null;
let activeOrderRequestId = "";
let activeReviewRequestId = "";
let orderSubmitting = false;
let reviewSubmitting = false;

const $ = id => document.getElementById(id);
const peso = n => new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0
}).format(Number(n) || 0);

async function api(action, payload = {}, options = {}) {
  if (!API || API.includes("PASTE_")) throw new Error("API URL is not configured in config.js");

  const maxRetries = Math.max(0, Number(options.retries ?? 2));
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      let response;

      try {
        response = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          cache: "no-store",
          body: JSON.stringify({ action, ...payload, requestTime: Date.now() }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);

      const data = await response.json();
      if (!data.ok) {
        const backendError = new Error(data.error || "Request failed");
        backendError.backend = true;
        throw backendError;
      }
      return data;
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err || "");
      const transient = !err?.backend || /busy|lock|timeout|temporar|try again|network|fetch|aborted/i.test(message);
      if (attempt >= maxRetries || !transient) throw err;
      await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1) + Math.random() * 500));
    }
  }

  throw lastError || new Error("Request failed");
}

function driveImageUrl(value, size = 1600) {
  const url = String(value || "").trim();
  if (!url) return FALLBACK_IMAGE;
  const match = url.match(/(?:[?&]id=|\/d\/)([-\w]{20,})/);
  return match ? `https://drive.google.com/thumbnail?id=${match[1]}&sz=w${size}` : url;
}

function imageSrc(value, size = 1600) {
  const url = driveImageUrl(value, size);
  if (url.startsWith("https://drive.google.com/thumbnail")) {
    return `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
  }
  return url;
}

function extractYouTubeId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return (url.pathname.split("/").filter(Boolean)[0] || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
      if (url.pathname === "/watch") return (url.searchParams.get("v") || "").replace(/[^A-Za-z0-9_-]/g, "");
      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) return (parts[1] || "").replace(/[^A-Za-z0-9_-]/g, "");
    }
  } catch (_) {}
  return "";
}

function extractDriveVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "drive.google.com") return "";
    const pathMatch = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    return (pathMatch?.[1] || url.searchParams.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "");
  } catch (_) {
    return "";
  }
}

function productVideoEmbedUrl(product) {
  const videoEnabled = product?.videoEnabled === true || Number(product?.videoEnabled) === 1 || String(product?.videoEnabled || "").toLowerCase() === "true";
  if (!product || !videoEnabled || !String(product.videoUrl || "").trim()) return "";
  const declaredType = String(product.videoType || "").toLowerCase();
  const youtubeId = extractYouTubeId(product.videoUrl);
  const driveId = extractDriveVideoId(product.videoUrl);

  if ((declaredType === "youtube" || !declaredType) && youtubeId) {
    return `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&modestbranding=1`;
  }
  if ((declaredType === "drive" || !declaredType) && driveId) {
    return `https://drive.google.com/file/d/${driveId}/preview`;
  }
  if (youtubeId) return `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&modestbranding=1`;
  if (driveId) return `https://drive.google.com/file/d/${driveId}/preview`;
  return "";
}

function safeImage(img, fallback = FALLBACK_IMAGE) {
  if (!img) return;
  img.onerror = () => {
    img.onerror = null;
    img.src = fallback;
  };
}


function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function facebookChatUrl() {
  const pageUrl = safeExternalUrl(storeSettings.facebookPageUrl);
  if (!pageUrl) return "";

  try {
    const url = new URL(pageUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (host === "m.me") return url.href;

    if (host === "facebook.com" || host === "fb.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const first = parts[0] || "";

      if (
        first &&
        !["pages", "profile.php", "groups", "share", "sharer"].includes(first.toLowerCase()) &&
        !/^\d+$/.test(first)
      ) {
        return `https://m.me/${encodeURIComponent(first)}`;
      }
    }
  } catch {}

  return pageUrl;
}

function renderSocialLinks() {
  const links = [
    ["facebookLink", storeSettings.facebookPageUrl],
    ["tiktokLink", storeSettings.tiktokUrl],
    ["youtubeLink", storeSettings.youtubeUrl]
  ];

  let visibleCount = 0;

  links.forEach(([id, value]) => {
    const element = $(id);
    const url = safeExternalUrl(value);
    if (!element) return;

    element.classList.toggle("hide", !url);
    if (url) {
      element.href = url;
      visibleCount += 1;
    } else {
      element.removeAttribute("href");
    }
  });

  $("socialSection")?.classList.toggle("hide", visibleCount === 0);

  const chatUrl = facebookChatUrl();
  $("floatingChatBtn")?.classList.toggle("hide", !chatUrl);
}

async function copyText(value) {
  const textValue = String(value || "");

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(textValue);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = textValue;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) throw new Error("Browser blocked automatic copy.");
}

function openSellerChat() {
  const url = facebookChatUrl();

  if (!url) {
    alert("Seller chat is not available yet.");
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function buildOrderMessage(order) {
  const itemLines = (order.items || []).map(item =>
    `• ${item.name} x${item.qty} — ${peso(Number(item.price || 0) * Number(item.qty || 0))}`
  );

  return [
    `Hi ${storeSettings.siteName || "Kawaii Aqua Pets"}! 🐠`,
    "",
    "I submitted an order from your website.",
    "",
    `ORDER ID: ${order.orderId}`,
    `CUSTOMER: ${order.customerName}`,
    `MOBILE: ${order.mobile}`,
    `EMAIL: ${order.email || ""}`,
    "",
    "ORDER:",
    ...itemLines,
    "",
    `TOTAL: ${peso(order.total)}`,
    `PAYMENT: ${order.paymentSummary}`,
    `DELIVERY: ${order.deliverySummary}`,
    "STATUS: Waiting for payment approval",
    "",
    "Please confirm my order. Thank you! 🐟"
  ].join("\n");
}

function showOrderSuccess(order) {
  lastSubmittedOrder = order;
  lastOrderMessage = buildOrderMessage(order);
  localStorage.setItem("kap_last_order_lookup", JSON.stringify({
    orderId: order.orderId,
    email: order.email || "",
    mobile: order.mobile || ""
  }));

  $("successOrderId").textContent = order.orderId;
  $("successOrderTotal").textContent = peso(order.total);
  $("orderSuccessSummary").textContent =
    `${order.paymentSummary} payment proof received. Your order is waiting for admin payment approval. Once approved, a payment receipt will be emailed to ${order.email}. Shipping fee is not included in the product total.`;

  const hasFacebook = Boolean(facebookChatUrl());
  $("sendOrderSellerBtn").classList.toggle("hide", !hasFacebook);
  $("messengerInstruction").classList.toggle("hide", !hasFacebook);
  $("orderSuccessMsg").textContent = "";

  $("orderSuccessDlg").showModal();
}

async function copyOrderAndOpenSeller() {
  if (!lastOrderMessage) return;

  const url = facebookChatUrl();
  if (!url) return;

  const chatWindow = window.open("about:blank", "_blank");

  try {
    await copyText(lastOrderMessage);
    $("orderSuccessMsg").textContent =
      "Order details copied. Facebook/Messenger is opening—paste the message and send it to the seller.";

    if (chatWindow) {
      chatWindow.opener = null;
      chatWindow.location.href = url;
    } else {
      window.location.href = url;
    }
  } catch (err) {
    if (chatWindow) chatWindow.close();
    $("orderSuccessMsg").textContent =
      err.message || "Could not copy the order details.";
  }
}

async function copyLastOrder() {
  if (!lastOrderMessage) return;

  try {
    await copyText(lastOrderMessage);
    $("orderSuccessMsg").textContent = "Order details copied.";
  } catch (err) {
    $("orderSuccessMsg").textContent =
      err.message || "Could not copy the order details.";
  }
}

function getSavedOrderLookup() {
  try {
    return JSON.parse(localStorage.getItem("kap_last_order_lookup") || "{}") || {};
  } catch {
    return {};
  }
}

function openTrackOrder(prefill = null) {
  const form = $("trackOrderForm");
  const saved = prefill || getSavedOrderLookup();

  if (saved) {
    form.orderId.value = saved.orderId || saved.id || "";
    form.contact.value = saved.email || saved.mobile || saved.contact || "";
  }

  $("trackOrderStatus").textContent = "";
  $("trackOrderResult").classList.add("hide");
  $("trackOrderResult").innerHTML = "";
  $("trackOrderDlg").showModal();
}

function formatDateTime(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("en-PH", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
}

function trackingStatusLabel(status) {
  const labels = {
    Pending: "Waiting for Payment Approval",
    Paid: "Payment Confirmed",
    Preparing: "Preparing Your Order",
    Ready: "Ready for Shipping",
    Shipped: "Shipped / Out for Delivery",
    Completed: "Order Completed",
    Cancelled: "Order Cancelled"
  };
  return labels[status] || status || "Order Received";
}

function renderTrackingResult(order) {
  const container = $("trackOrderResult");
  const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  const eventMap = {};
  history.forEach(event => {
    if (event?.status && !eventMap[event.status]) eventMap[event.status] = event.at || "";
  });

  const steps = [
    {key: "Received", eventStatus: "Pending", label: "Order Received", description: "Your order and payment proof were submitted."},
    {key: "Paid", eventStatus: "Paid", label: "Payment Confirmed", description: "The seller approved your payment."},
    {key: "Preparing", eventStatus: "Preparing", label: "Preparing Your Order", description: "Your order is being prepared for shipment."},
    {key: "Ready", eventStatus: "Ready", label: "Ready for Shipping", description: "Your parcel is ready for courier handoff."},
    {key: "Shipped", eventStatus: "Shipped", label: "Shipped / Out for Delivery", description: "Your order has been handed to the selected delivery service."},
    {key: "Completed", eventStatus: "Completed", label: "Order Completed", description: "The order has been completed."}
  ];
  const statusStepIndex = {
    Pending: 1,
    Paid: 1,
    Preparing: 2,
    Ready: 3,
    Shipped: 4,
    Completed: 5
  };
  const currentStatus = order.status || "Pending";
  const currentStepIndex = statusStepIndex[currentStatus] ?? 1;
  const isCancelled = currentStatus === "Cancelled";

  const timelineHtml = steps.map((step, index) => {
    let state = "upcoming";

    if (isCancelled) {
      state = index === 0 || eventMap[step.eventStatus] ? "done" : "upcoming";
    } else if (index === 0) {
      state = "done";
    } else if (index < currentStepIndex) {
      state = "done";
    } else if (index === currentStepIndex) {
      state = "current";
    }

    const at = step.key === "Received"
      ? (eventMap.Pending || order.createdAt)
      : eventMap[step.eventStatus] || "";
    const label = currentStatus === "Pending" && step.key === "Paid"
      ? "Waiting for Payment Confirmation"
      : step.label;
    const description = currentStatus === "Pending" && step.key === "Paid"
      ? "Your proof of payment is waiting for seller approval."
      : step.description;

    return `
      <div class="trackStep ${state}">
        <div class="trackStepMarker">${state === "done" ? "✓" : state === "current" ? "●" : ""}</div>
        <div class="trackStepContent">
          <b>${escapeHtml(label)}</b>
          <p>${escapeHtml(description)}</p>
          ${at ? `<small>${escapeHtml(formatDateTime(at))}</small>` : ""}
        </div>
      </div>
    `;
  }).join("");

  const courierAction = order.trackingUrl
    ? `<a class="btn trackCourierBtn" href="${escapeHtml(order.trackingUrl)}" target="_blank" rel="noopener noreferrer">Open Courier Tracking</a>`
    : "";

  const itemsHtml = (order.items || []).map(item => `
    <div class="trackItemRow">
      <span>${escapeHtml(item.name)} × ${Number(item.qty) || 1}</span>
      <b>${peso(Number(item.price || 0) * Number(item.qty || 0))}</b>
    </div>
  `).join("");

  container.innerHTML = `
    <section class="trackOrderCard">
      <div class="trackOrderCardHead">
        <div>
          <small>ORDER ID</small>
          <b>${escapeHtml(order.id)}</b>
        </div>
        <span class="trackStatusBadge ${isCancelled ? "cancelled" : ""}">${escapeHtml(trackingStatusLabel(currentStatus))}</span>
      </div>
      <div class="trackMetaGrid">
        <div><small>PRODUCT TOTAL</small><b>${peso(order.total)}</b><span>Shipping fee not included</span></div>
        <div><small>PAYMENT</small><b>${escapeHtml(order.paymentSummary || "—")}</b></div>
        <div><small>DELIVERY</small><b>${escapeHtml(order.deliverySummary || order.deliveryMethod || "—")}</b></div>
        ${order.trackingNumber ? `<div><small>TRACKING NUMBER</small><b class="trackingNumberText">${escapeHtml(order.trackingNumber)}</b></div>` : ""}
      </div>
      ${courierAction}
    </section>

    ${isCancelled ? `
      <div class="trackCancelledNotice">
        <b>Order Cancelled</b>
        <span>This order has been cancelled. Contact the seller if you need assistance.</span>
        ${eventMap.Cancelled ? `<small>${escapeHtml(formatDateTime(eventMap.Cancelled))}</small>` : ""}
      </div>
    ` : ""}

    <section class="trackTimeline">
      <h3>Order Timeline</h3>
      ${timelineHtml}
    </section>

    <section class="trackItemsCard">
      <h3>Order Items</h3>
      ${itemsHtml}
      <div class="trackItemTotal"><span>Product Total</span><b>${peso(order.total)}</b></div>
      <small>Shipping fee is not included in the product total.</small>
    </section>
  `;

  container.classList.remove("hide");
}

function cartTotal() {
  return cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0), 0);
}

function getCheckoutItems() {
  return checkoutMode === "buyNow" && buyNowItem
    ? [{...buyNowItem}]
    : cart.map(item => ({...item}));
}

function checkoutTotal() {
  return getCheckoutItems().reduce(
    (sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0),
    0
  );
}

function renderCheckoutMiniSummary() {
  const box = $("checkoutMiniSummary");
  if (!box) return;

  const items = getCheckoutItems();
  const title = checkoutMode === "buyNow" ? "Buy Now" : "Cart Checkout";

  box.innerHTML = `
    <div>
      <small>${escapeHtml(title.toUpperCase())}</small>
      <b>${items.map(item => `${escapeHtml(item.name)} x${Number(item.qty) || 1}`).join(", ")}</b>
    </div>
    <strong>${peso(checkoutTotal())}</strong>
  `;
}

function openCheckout(mode = "cart", productId = "") {
  if (mode === "buyNow") {
    const product = products.find(item => item.id === productId);
    if (!product) return alert("Product is not available.");

    const stock = Math.max(0, Number(product.stock) || 0);
    if (stock <= 0) return alert("This item is sold out.");

    checkoutMode = "buyNow";
    buyNowItem = {
      id: product.id,
      name: product.name,
      price: Number(product.price),
      imageUrl: product.imageUrl,
      qty: 1
    };
  } else {
    if (!cart.length) return alert("Cart is empty");
    checkoutMode = "cart";
    buyNowItem = null;
    closeCart();
  }

  renderDeliveryOptions();
  toggleDeliveryFields();
  renderCheckoutMiniSummary();
  renderPaymentDetails();
  $("status").textContent = "";
  $("checkoutDlg").showModal();
}

function showAddedToCartToast(product) {
  let toast = document.getElementById("cartToast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "cartToast";
    toast.className = "cartToast";
    toast.innerHTML = `
      <div class="cartToastIcon">✓</div>
      <div class="cartToastText">
        <b id="cartToastTitle">Added to cart</b>
        <span id="cartToastProduct"></span>
      </div>
      <button type="button" id="cartToastView">View Cart</button>
    `;
    document.body.appendChild(toast);
    toast.querySelector("#cartToastView").onclick = () => {
      toast.classList.remove("show");
      openCart();
    };
  }

  toast.querySelector("#cartToastTitle").textContent = "Added to cart";
  toast.querySelector("#cartToastProduct").textContent = product.name;
  toast.classList.remove("show");
  void toast.offsetWidth;
  toast.classList.add("show");

  clearTimeout(showAddedToCartToast.timer);
  showAddedToCartToast.timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2800);
}

function selectedPaymentMethod(form = $("checkoutForm")) {
  return form.querySelector('input[name="paymentMethod"]:checked')?.value || "";
}

function getPaymentInfo(method) {
  if (method === "unionbank") {
    return {
      method: "unionbank",
      label: "UnionBank",
      accountName: storeSettings.unionBankName || "JOEBERT O GREGANDA",
      accountHint: storeSettings.unionBankAccountHint || "**** **** 6628",
      qrUrl: storeSettings.unionBankQrUrl || DEFAULT_PAYMENT_QR.unionbank,
      fileId: storeSettings.unionBankQrFileId || ""
    };
  }

  return {
    method: "gcash",
    label: "GCash",
    accountName: storeSettings.gcashName || "Joebert Greganda",
    accountHint: storeSettings.gcashNumber || "",
    qrUrl: storeSettings.gcashQrUrl || DEFAULT_PAYMENT_QR.gcash,
    fileId: storeSettings.gcashQrFileId || ""
  };
}

function renderPaymentDetails() {
  const method = selectedPaymentMethod();
  const box = $("paymentBox");

  box.classList.toggle("hide", !method);
  $("paymentAmount").textContent = peso(checkoutTotal());

  if (!method) return;

  const info = getPaymentInfo(method);
  $("paymentProvider").textContent = info.label;
  $("paymentAccountName").textContent = info.accountName;
  $("paymentAccountHint").textContent = info.accountHint;
  $("paymentAccountHint").classList.toggle("hide", !info.accountHint);
  $("paymentQr").src = imageSrc(info.qrUrl, 1800);
  $("paymentQr").alt = `${info.label} payment QR code`;
  $("paymentNote").textContent = storeSettings.paymentNote || "Using one phone only? Download the QR first, then select the saved QR image inside your payment app.";
}

function triggerDownload(dataUrl, filename) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function downloadPaymentQr() {
  const method = selectedPaymentMethod();
  if (!method) return alert("Please select GCash or UnionBank first.");

  const info = getPaymentInfo(method);
  const filename = `Kawaii-Aqua-Pets-${info.label}-QR.${method === "unionbank" ? "jpeg" : "jpg"}`;
  const isDriveImage = Boolean(info.fileId) || /drive\.google\.com/.test(info.qrUrl);

  try {
    if (isDriveImage) {
      const result = await api("getPaymentQr", {method});
      if (!result.dataUrl) throw new Error("Payment QR is not available for download.");
      triggerDownload(result.dataUrl, result.filename || filename);
      return;
    }

    const link = document.createElement("a");
    link.href = info.qrUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (err) {
    alert(err.message || "Could not download the QR. Use View Full Size and save the image instead.");
  }
}

function viewPaymentQr() {
  const method = selectedPaymentMethod();
  if (!method) return alert("Please select GCash or UnionBank first.");
  window.open(imageSrc(getPaymentInfo(method).qrUrl, 2000), "_blank", "noopener");
}

async function optimizeImage(file, maxDimension = 1600, quality = 0.86) {
  if (!file) return "";
  if (!file.type.startsWith("image/")) throw new Error("Please select a valid image file.");
  if (file.size > 10 * 1024 * 1024) throw new Error("Original image must be 10 MB or less.");

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const mime = file.type === "image/png" && file.size < 2.5 * 1024 * 1024 ? "image/png" : "image/jpeg";
  return canvas.toDataURL(mime, mime === "image/png" ? undefined : quality);
}

async function load(silent = false) {
  let storeData = null;

  try {
    storeData = await api("getStore");
    $("demoBanner")?.classList.add("hide");
  } catch (err) {
    if (LOCAL_DEMO_MODE) {
      storeData = buildLocalDemoStore();
      $("demoBanner")?.classList.remove("hide");
    } else {
      if (!silent) console.error(err);
      $("lalamoveFormLink").href = DEFAULT_LALAMOVE_FORM_URL;
      $("jntOrderLink").href = JNT_ORDER_URL;
      renderDeliveryOptions();
      renderPaymentDetails();
      renderSocialLinks();
    }
  }

  if (storeData) {
    products = storeData.products || [];
    categories = (storeData.categories || []).map(category => ({
      ...category,
      parentId: String(category.parentId || ""),
      active: category.active !== false && String(category.active) !== "false"
    }));
    reviews = storeData.reviews || [];
    storeSettings = storeData.settings || {};

    Object.entries(storeSettings).forEach(([key, value]) => {
      const element = $(key);
      if (element) element.textContent = value;
    });

    if (storeSettings.siteName) document.title = storeSettings.siteName;
    if (storeSettings.logoUrl) {
      $("logo").src = imageSrc(storeSettings.logoUrl, 800);
    }

    $("lalamoveFormLink").href = storeSettings.lalamoveFormUrl || DEFAULT_LALAMOVE_FORM_URL;
    $("jntOrderLink").href = storeSettings.jntOrderUrl || JNT_ORDER_URL;
    renderDeliveryOptions();
    renderPaymentDetails();
    renderSocialLinks();
  }

  syncCartWithStock();
  renderCategories();
  renderHeroFeature();
  renderProducts();
  renderCart();
  renderReviews();
  renderReviewProducts();
}

function categoryEmoji(name) {
  const key = String(name || "").toLowerCase();
  if (key.includes("betta")) return "🐟";
  if (key.includes("gupp")) return "🐠";
  if (key.includes("plant") || key.includes("anubias")) return "🌿";
  if (key.includes("snail")) return "🐌";
  if (key.includes("shrimp")) return "🦐";
  return "🌊";
}

function categoryById(id) {
  return categories.find(category => category.id === id);
}

function categoryChildren(parentId = "") {
  return categories.filter(category => String(category.parentId || "") === String(parentId || ""));
}

function categoryDescendantIds(id) {
  const result = new Set();
  const visit = parentId => categoryChildren(parentId).forEach(category => {
    if (result.has(category.id)) return;
    result.add(category.id);
    visit(category.id);
  });
  visit(id);
  return result;
}

function categoryRoot(category) {
  let current = category;
  const seen = new Set();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = categoryById(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function categoryPath(categoryOrId) {
  let current = typeof categoryOrId === "string" ? categoryById(categoryOrId) : categoryOrId;
  const parts = [];
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = categoryById(current.parentId);
  }
  return parts.join(" › ");
}

function orderedCategories() {
  const ordered = [];
  const visited = new Set();
  const walk = (parentId, depth) => {
    categoryChildren(parentId)
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .forEach(category => {
        if (visited.has(category.id)) return;
        visited.add(category.id);
        ordered.push({category, depth});
        walk(category.id, depth + 1);
      });
  };
  walk("", 0);
  categories.filter(category => !visited.has(category.id)).forEach(category => ordered.push({category, depth: 0}));
  return ordered;
}

function categoryProductIds(categoryId) {
  return new Set([categoryId, ...categoryDescendantIds(categoryId)]);
}

function productsForCategory(categoryId) {
  if (!categoryId) return products;
  const ids = categoryProductIds(categoryId);
  return products.filter(product => ids.has(product.categoryId));
}

function renderHeroFeature() {
  const hero = $("heroImage");
  if (!hero) return;
  const featured = products.find(product => String(product.categoryName || "").toLowerCase().includes("betta")) || products[0];
  hero.src = featured ? imageSrc(featured.imageUrl, 1400) : imageSrc(storeSettings.logoUrl || FALLBACK_IMAGE, 1200);
  hero.alt = featured ? featured.name : "Kawaii Aqua Pets";
  safeImage(hero);
}

function renderCategoryCards() {
  const root = $("categoryCards");
  if (!root) return;
  const mainCategories = categoryChildren("");

  root.innerHTML = mainCategories.map(category => {
    const categoryProducts = productsForCategory(category.id);
    const featured = category.imageUrl ? null : categoryProducts[0];
    const image = category.imageUrl || featured?.imageUrl || "";
    const subCount = categoryDescendantIds(category.id).size;
    return `
      <button type="button" class="categoryCard" data-category-card="${escapeHtml(category.id)}">
        <span class="categoryImageWrap">
          ${image ? `<img src="${escapeHtml(imageSrc(image, 800))}" alt="${escapeHtml(category.name)}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">` : `<span class="categoryFallback">${categoryEmoji(category.name)}</span>`}
        </span>
        <span class="categoryCardCopy"><b>${categoryEmoji(category.name)} ${escapeHtml(category.name)}</b><small>${subCount ? `${subCount} subcategor${subCount === 1 ? "y" : "ies"} • ` : ""}${categoryProducts.length} product${categoryProducts.length === 1 ? "" : "s"}</small></span>
        <span class="categoryArrow">→</span>
      </button>`;
  }).join("") || '<div class="emptyProducts">No categories available yet.</div>';

  root.querySelectorAll("[data-category-card]").forEach(button => {
    button.onclick = () => {
      $("filter").value = button.dataset.categoryCard || "";
      renderCategoryChips();
      renderProducts();
      $("products")?.scrollIntoView({behavior: "smooth", block: "start"});
    };
  });
}

function renderCategoryChips() {
  const chipRoot = $("categoryChips");
  if (!chipRoot) return;

  const selected = $("filter").value;
  const selectedCategory = categoryById(selected);
  const rootCategory = selectedCategory ? categoryRoot(selectedCategory) : null;
  const mainCategories = categoryChildren("");

  const mainHtml = [{id: "", name: "All Products"}, ...mainCategories].map(category => `
    <button type="button" class="categoryChip ${selected === category.id || (rootCategory && rootCategory.id === category.id) ? "active" : ""}" data-category="${escapeHtml(category.id)}">${escapeHtml(category.name)}</button>
  `).join("");

  let subHtml = "";
  if (rootCategory) {
    const descendants = orderedCategories().filter(({category}) => {
      if (category.id === rootCategory.id) return false;
      return categoryRoot(category)?.id === rootCategory.id;
    });
    if (descendants.length) {
      subHtml = `<div class="subcategoryChipGroup"><span class="subcategoryLabel">${escapeHtml(rootCategory.name)} subcategories:</span>
        <button type="button" class="subcategoryChip ${selected === rootCategory.id ? "active" : ""}" data-category="${escapeHtml(rootCategory.id)}">All ${escapeHtml(rootCategory.name)}</button>
        ${descendants.map(({category, depth}) => `<button type="button" class="subcategoryChip ${selected === category.id ? "active" : ""}" data-category="${escapeHtml(category.id)}">${category.imageUrl ? `<img src="${escapeHtml(imageSrc(category.imageUrl, 240))}" alt="" onerror="this.style.display='none'">` : ""}<span>${"↳ ".repeat(Math.max(0, depth - 1))}${escapeHtml(category.name)}</span></button>`).join("")}
      </div>`;
    }
  }

  chipRoot.innerHTML = `<div class="mainCategoryChips">${mainHtml}</div>${subHtml}`;
  chipRoot.querySelectorAll("[data-category]").forEach(button => {
    button.onclick = () => {
      $("filter").value = button.dataset.category || "";
      renderCategoryChips();
      renderProducts();
    };
  });
}

function renderCategories() {
  const currentValue = $("filter").value;
  $("filter").innerHTML = '<option value="">All categories</option>' +
    orderedCategories().map(({category, depth}) => `<option value="${escapeHtml(category.id)}">${"— ".repeat(depth)}${escapeHtml(category.name)}</option>`).join("");

  if ([...$("filter").options].some(option => option.value === currentValue)) $("filter").value = currentValue;
  renderCategoryChips();
  renderCategoryCards();
}

function renderProducts() {
  const filter = $("filter").value;
  const visible = productsForCategory(filter);

  $("grid").innerHTML = visible.map(p => {
    const stock = Math.max(0, Number(p.stock) || 0);
    const soldOut = stock <= 0;
    const lowStock = stock > 0 && stock <= 5;
    const categoryLabel = p.categoryPath || categoryPath(p.categoryId) || p.categoryName || "Aqua Pet";
    return `
      <article class="card premiumProductCard">
        <div class="productMedia">
          <img src="${escapeHtml(imageSrc(p.imageUrl))}" alt="${escapeHtml(p.name)}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
          <span class="productCategoryBadge">${categoryEmoji(categoryLabel)} ${escapeHtml(categoryLabel)}</span>
          <span class="stockPill ${soldOut ? "soldOut" : lowStock ? "lowStock" : ""}">${soldOut ? "Sold Out" : lowStock ? `Only ${stock} left` : "In Stock"}</span>
          ${productVideoEmbedUrl(p) ? '<span class="actualVideoBadge">▶ Actual Video</span>' : ""}
        </div>
        <div class="productCardBody">
          <h3>${escapeHtml(p.name)}</h3>
          <p>${escapeHtml(p.description || "")}</p>
          <div class="productPriceRow"><div><small>PRICE</small><b>${peso(p.price)}</b></div><span>${soldOut ? "Unavailable" : `${stock} available`}</span></div>
          <div class="productActions">
            <button class="btn viewDetailsBtn" onclick="openProductDetails('${escapeHtml(p.id)}')">View Details</button>
            <button class="btn secondary addCartBtn" ${soldOut ? "disabled" : ""} onclick="add('${escapeHtml(p.id)}')">${soldOut ? "Sold Out" : "Add to Cart"}</button>
            <button class="btn buyNowBtn" ${soldOut ? "disabled" : ""} onclick="buyNow('${escapeHtml(p.id)}')">${soldOut ? "Unavailable" : "Buy Now"}</button>
          </div>
        </div>
      </article>`;
  }).join("") || '<div class="emptyProducts"><span>🐠</span><b>No products available in this category yet.</b><p>Choose another category to continue browsing.</p></div>';
}

function renderReviews() {
  if (!reviews.length) {
    $("reviewSummary").textContent = "No reviews yet. Be the first to share your experience.";
    $("reviewsGrid").innerHTML = '<div class="reviewEmpty">No customer reviews yet.</div>';
    return;
  }

  const average = reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / reviews.length;
  $("reviewSummary").textContent = `${average.toFixed(1)} out of 5 • ${reviews.length} review${reviews.length === 1 ? "" : "s"}`;

  $("reviewsGrid").innerHTML = reviews.map(r => {
    const rating = Math.max(1, Math.min(5, Number(r.rating) || 5));
    const initials = String(r.customerName || "K").split(/\s+/).map(part => part[0] || "").join("").slice(0, 2).toUpperCase();
    return `
      <article class="reviewCard premiumReviewCard">
        <div class="reviewBody">
          <div class="reviewTopRow">
            ${r.imageUrl ? `<img class="reviewAvatar" src="${escapeHtml(imageSrc(r.imageUrl, 320))}" alt="Customer review photo" onerror="this.outerHTML='<span class=\'reviewAvatar reviewInitials\'>${escapeHtml(initials)}</span>'">` : `<span class="reviewAvatar reviewInitials">${escapeHtml(initials)}</span>`}
            <div class="reviewCustomer"><h3>${escapeHtml(r.customerName)}</h3><div class="reviewStars">${"★".repeat(rating)}${"☆".repeat(5-rating)}</div></div>
            ${r.isDemo ? '<span class="demoReviewBadge">DEMO</span>' : ""}
          </div>
          ${r.productName ? `<span class="reviewProduct">${categoryEmoji(r.productName)} ${escapeHtml(r.productName)}</span>` : ""}
          <p class="reviewText">${escapeHtml(r.reviewText)}</p>
          <span class="reviewDate">${escapeHtml(formatDate(r.createdAt))}</span>
        </div>
      </article>`;
  }).join("");
}

function renderReviewProducts() {
  $("reviewProduct").innerHTML = '<option value="">General store review</option>' +
    products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
}


function closeProductDetails() {
  const dialog = $("productDetailsDlg");
  const frame = $("detailVideoFrame");
  if (frame) frame.src = "";
  if (dialog?.open) dialog.close();
}

function openProductDetails(id) {
  const product = products.find(item => item.id === id);
  if (!product) return;

  const stock = Math.max(0, Number(product.stock) || 0);
  const soldOut = stock <= 0;
  const embedUrl = productVideoEmbedUrl(product);

  $("detailProductImage").src = imageSrc(product.imageUrl, 1400);
  $("detailProductImage").alt = product.name || "Product image";
  $("detailCategory").textContent = `${categoryEmoji(product.categoryName)} ${product.categoryName || "Aqua Pet"}`;
  $("detailName").textContent = product.name || "Product";
  $("detailDescription").textContent = product.description || "No description available.";
  $("detailPrice").textContent = peso(product.price);
  $("detailStock").textContent = soldOut ? "Sold Out" : `${stock} available`;
  $("detailStock").className = `detailStock ${soldOut ? "soldOut" : stock <= 5 ? "lowStock" : ""}`;

  const videoWrap = $("detailVideoWrap");
  const noVideo = $("detailNoVideo");
  const frame = $("detailVideoFrame");
  frame.src = "";
  videoWrap.classList.toggle("hide", !embedUrl);
  noVideo.classList.toggle("hide", Boolean(embedUrl));
  if (embedUrl) frame.src = embedUrl;

  const addButton = $("detailAddBtn");
  const buyButton = $("detailBuyBtn");
  addButton.disabled = soldOut;
  buyButton.disabled = soldOut;
  addButton.textContent = soldOut ? "Sold Out" : "Add to Cart";
  buyButton.textContent = soldOut ? "Unavailable" : "Buy Now";
  addButton.onclick = () => {
    add(product.id);
    if (!soldOut) closeProductDetails();
  };
  buyButton.onclick = () => {
    closeProductDetails();
    buyNow(product.id);
  };

  const dialog = $("productDetailsDlg");
  if (!dialog.open) dialog.showModal();
}

function add(id) {
  const product = products.find(x => x.id === id);
  if (!product) return;

  const stock = Math.max(0, Number(product.stock) || 0);
  if (stock <= 0) return alert("This item is sold out.");

  const item = cart.find(x => x.id === id);
  const currentQty = item ? Number(item.qty) : 0;
  if (currentQty >= stock) return alert(`Only ${stock} item(s) available.`);

  if (item) item.qty += 1;
  else cart.push({
    id: product.id,
    name: product.name,
    price: Number(product.price),
    imageUrl: product.imageUrl,
    qty: 1
  });

  save();
  showAddedToCartToast(product);
}

function buyNow(id) {
  openCheckout("buyNow", id);
}

function changeQty(index, delta) {
  const item = cart[index];
  const product = products.find(p => p.id === item.id);
  const stock = product ? Math.max(0, Number(product.stock) || 0) : 0;

  if (delta > 0 && item.qty >= stock) return alert(`Only ${stock} item(s) available.`);
  item.qty = Math.max(1, item.qty + delta);
  save();
}

function syncCartWithStock() {
  cart = cart.map(item => {
    const product = products.find(p => p.id === item.id);
    if (!product || Number(product.stock) <= 0) return null;
    return {
      id: product.id,
      name: product.name,
      price: Number(product.price),
      imageUrl: product.imageUrl,
      qty: Math.min(Math.max(1, Number(item.qty) || 1), Number(product.stock))
    };
  }).filter(Boolean);

  localStorage.setItem("cart", JSON.stringify(cart));
}

function save() {
  localStorage.setItem("cart", JSON.stringify(cart));
  renderCart();
}

function renderCart() {
  $("cartCount").textContent = cart.reduce((sum, item) => sum + item.qty, 0);
  $("cartItems").innerHTML = cart.map((item, index) => `
    <div class="cartItem">
      <img src="${escapeHtml(imageSrc(item.imageUrl, 500))}" alt="${escapeHtml(item.name)}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
      <div>
        <b>${escapeHtml(item.name)}</b>
        <div>${peso(item.price)} each</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <button type="button" onclick="changeQty(${index},-1)">−</button>
          <strong>${item.qty}</strong>
          <button type="button" onclick="changeQty(${index},1)">+</button>
        </div>
      </div>
      <button onclick="cart.splice(${index},1);save()">×</button>
    </div>
  `).join("") || "<p style='padding:18px'>Cart is empty.</p>";

  $("total").textContent = peso(cartTotal());
  renderPaymentDetails();
}

function openCart() {
  $("cart").classList.add("open");
  $("overlay").classList.remove("hide");
}

function closeCart() {
  $("cart").classList.remove("open");
  $("overlay").classList.add("hide");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[c]);
}

function demoProductImage(name, category, colorA, colorB, variant = 1) {
  const type = String(category || "").toLowerCase();
  const spotShift = Number(variant || 1) * 9;
  let subject = "";

  if (type === "snails") {
    subject =
      `<ellipse cx="425" cy="365" rx="180" ry="54" fill="${colorB}" opacity=".95"/>` +
      `<circle cx="405" cy="315" r="122" fill="${colorA}"/>` +
      `<circle cx="405" cy="315" r="78" fill="none" stroke="#ffffff" stroke-width="18" opacity=".55"/>` +
      `<circle cx="405" cy="315" r="35" fill="none" stroke="#ffffff" stroke-width="12" opacity=".45"/>` +
      '<circle cx="575" cy="338" r="18" fill="#ffffff"/>' +
      '<circle cx="582" cy="338" r="8" fill="#162b32"/>' +
      '<path d="M565 310 Q575 260 596 244 M586 312 Q606 270 630 263" stroke="#415d58" stroke-width="8" stroke-linecap="round"/>';
  } else if (type === "shrimps") {
    subject =
      `<path d="M275 355 Q365 215 535 285 Q625 320 600 430 Q570 535 405 475" fill="none" stroke="${colorA}" stroke-width="74" stroke-linecap="round"/>` +
      `<path d="M320 330 Q390 260 500 295" fill="none" stroke="${colorB}" stroke-width="18" stroke-linecap="round" opacity=".9"/>` +
      '<circle cx="563" cy="318" r="15" fill="#ffffff"/>' +
      '<circle cx="568" cy="319" r="7" fill="#132b31"/>' +
      `<path d="M610 338 Q680 285 725 300 M610 356 Q690 350 730 390" fill="none" stroke="${colorA}" stroke-width="12" stroke-linecap="round"/>` +
      `<path d="M345 410 l-60 80 M405 445 l-35 92 M470 455 l5 86" stroke="${colorA}" stroke-width="12" stroke-linecap="round"/>`;
  } else {
    subject =
      `<polygon points="250,350 115,245 125,455" fill="${colorB}" opacity=".95"/>` +
      `<ellipse cx="445" cy="350" rx="220" ry="128" fill="${colorA}"/>` +
      `<path d="M400 245 Q475 150 560 235 Q505 260 455 305" fill="${colorB}" opacity=".85"/>` +
      `<path d="M395 455 Q475 540 565 452 Q500 430 445 395" fill="${colorB}" opacity=".82"/>` +
      '<circle cx="585" cy="322" r="22" fill="#ffffff"/>' +
      '<circle cx="592" cy="325" r="10" fill="#10231f"/>' +
      `<circle cx="${330 + spotShift}" cy="325" r="28" fill="${colorB}" opacity=".65"/>` +
      `<circle cx="${420 + spotShift}" cy="385" r="21" fill="#ffffff" opacity=".45"/>` +
      `<circle cx="${505 - spotShift}" cy="305" r="18" fill="${colorB}" opacity=".6"/>`;
  }

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 700">' +
      '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#dff7f4"/><stop offset="1" stop-color="#f7fbff"/>' +
      '</linearGradient></defs>' +
      '<rect width="900" height="700" rx="48" fill="url(#bg)"/>' +
      '<circle cx="105" cy="115" r="38" fill="#ffffff" opacity=".6"/>' +
      '<circle cx="760" cy="145" r="24" fill="#ffffff" opacity=".7"/>' +
      '<circle cx="805" cy="240" r="14" fill="#ffffff" opacity=".8"/>' +
      '<path d="M40 520 Q140 455 220 525 T410 515 T610 525 T860 505 V700 H40Z" fill="#bfe9df" opacity=".72"/>' +
      '<path d="M75 540 Q110 445 135 540 M155 540 Q205 425 220 540 M710 540 Q740 435 765 540 M775 540 Q820 460 842 540" stroke="#58a995" stroke-width="18" stroke-linecap="round" fill="none" opacity=".72"/>' +
      subject +
      '<rect x="54" y="535" width="792" height="118" rx="28" fill="#ffffff" opacity=".94"/>' +
      `<text x="84" y="582" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#087f67">${escapeHtml(category).toUpperCase()}</text>` +
      `<text x="84" y="626" font-family="Arial,sans-serif" font-size="35" font-weight="800" fill="#10231f">${escapeHtml(name)}</text>` +
    '</svg>';

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildLocalDemoStore() {
  const categoryDefs = [
    {id: "DEMO_CAT_BETTA", name: "Betta"},
    {id: "DEMO_CAT_GUPPIES", name: "Guppies"},
    {id: "DEMO_CAT_SNAILS", name: "Snails"},
    {id: "DEMO_CAT_SHRIMPS", name: "Shrimps"}
  ];
  const categoryIds = Object.fromEntries(categoryDefs.map(category => [category.name.toLowerCase(), category.id]));

  const productDefs = [
    ["DEMO_PRD_BETTA_001", "Galaxy Koi Betta Male", "Betta", 350, 8, "Bright galaxy-koi pattern with bold red, blue, and marble tones. Individually kept and carefully packed.", "#e54b64", "#3157d7", 1],
    ["DEMO_PRD_BETTA_002", "Dumbo Halfmoon Betta", "Betta", 420, 5, "Large dumbo fins with a wide halfmoon tail. A premium centerpiece betta for planted tanks.", "#f4c6ff", "#7b4bd9", 2],
    ["DEMO_PRD_BETTA_003", "Avatar Blue Betta", "Betta", 480, 4, "Deep electric-blue body with dark contrast and metallic shine. Limited demo stock.", "#1f4fd6", "#38c7e8", 3],
    ["DEMO_PRD_BETTA_004", "Nemo Candy Betta", "Betta", 390, 7, "Colorful nemo candy mix with orange, red, white, and speckled markings. Each fish has a unique pattern.", "#ff7a3d", "#ffe06b", 4],
    ["DEMO_PRD_BETTA_005", "Samurai Black Betta", "Betta", 450, 3, "Dark samurai-style betta with metallic scale contrast. Best for hobbyists who like dramatic colors.", "#20242a", "#9aa4b2", 5],
    ["DEMO_PRD_BETTA_006", "Female Betta Sorority Pack", "Betta", 650, 6, "Demo pack of assorted female bettas for experienced keepers planning a properly sized sorority setup.", "#ef6aa8", "#f4b5d2", 6],
    ["DEMO_PRD_GUPPY_001", "Blue Moscow Guppy Pair", "Guppies", 220, 12, "Healthy male and female pair with rich blue Moscow coloration. Great starter breeding pair.", "#245edb", "#4ec5e8", 7],
    ["DEMO_PRD_GUPPY_002", "Full Red Guppy Trio", "Guppies", 280, 10, "One male and two females with strong full-red color. Active, hardy, and suitable for breeding projects.", "#d93131", "#ff7f61", 8],
    ["DEMO_PRD_GUPPY_003", "Purple Dragon Guppy Pair", "Guppies", 260, 8, "Purple dragon pattern with detailed body scales and flowing tails. Carefully selected demo pair.", "#7e45c9", "#d886ef", 9],
    ["DEMO_PRD_GUPPY_004", "Koi Tuxedo Guppy Trio", "Guppies", 300, 6, "Koi head color with tuxedo body contrast. Trio setup is ideal for hobbyist breeding tanks.", "#ff6b4a", "#343a55", 10],
    ["DEMO_PRD_GUPPY_005", "Albino Full Platinum Guppy Pair", "Guppies", 320, 5, "Light platinum body with albino eyes and clean metallic finish. Premium-looking pair for display tanks.", "#f6f1de", "#d8d4c8", 11],
    ["DEMO_PRD_SNAIL_001", "Nerite Snail 3 pcs", "Snails", 120, 20, "Three assorted nerite snails. Popular algae grazers for freshwater aquariums.", "#6b5135", "#c59b62", 12],
    ["DEMO_PRD_SNAIL_002", "Mystery Snail Gold", "Snails", 80, 18, "Bright golden mystery snail with a cute round shell. Peaceful addition to community tanks.", "#f0b930", "#ffe790", 13],
    ["DEMO_PRD_SNAIL_003", "Pink Ramshorn Snail 5 pcs", "Snails", 100, 15, "Five pink ramshorn snails with soft rose shell tones. Great for planted aquarium clean-up crews.", "#ee8fb3", "#ffd1df", 14],
    ["DEMO_PRD_SNAIL_004", "Assassin Snail", "Snails", 90, 12, "Striped assassin snail often kept by hobbyists managing pest snail populations.", "#d7a33d", "#4e3825", 15],
    ["DEMO_PRD_SHRIMP_001", "Red Cherry Shrimp 10 pcs", "Shrimps", 280, 20, "Ten active red cherry shrimps for planted nano tanks. Great beginner shrimp colony starter.", "#e63232", "#ff8173", 16],
    ["DEMO_PRD_SHRIMP_002", "Blue Dream Shrimp 10 pcs", "Shrimps", 380, 12, "Ten blue dream shrimps with deep blue body color. Best viewed on light substrate and green plants.", "#3159c9", "#4cc8e6", 17],
    ["DEMO_PRD_SHRIMP_003", "Yellow Goldenback Shrimp 10 pcs", "Shrimps", 350, 10, "Ten yellow goldenback shrimps with bright dorsal color. Eye-catching in planted aquascapes.", "#f2c72e", "#fff08a", 18],
    ["DEMO_PRD_SHRIMP_004", "Amano Shrimp 5 pcs", "Shrimps", 300, 14, "Five amano shrimps known among aquarists as active algae grazers and tank clean-up helpers.", "#879b8a", "#d0ddd3", 19],
    ["DEMO_PRD_SHRIMP_005", "Crystal Red Shrimp 5 pcs", "Shrimps", 450, 6, "Five crystal red shrimps with classic red-and-white banding. Recommended for stable mature tanks.", "#d92f3d", "#f8f5ef", 20]
  ];

  const demoProducts = productDefs.map(([id, name, categoryName, price, stock, description, colorA, colorB, variant]) => ({
    id,
    name,
    categoryId: categoryIds[categoryName.toLowerCase()],
    categoryName,
    price,
    stock,
    description,
    active: true,
    imageUrl: demoProductImage(name, categoryName, colorA, colorB, variant)
  }));

  const productByName = Object.fromEntries(demoProducts.map(product => [product.name, product]));
  const reviewDefs = [
    [3, "Ana M.", "Galaxy Koi Betta Male", 5, "DEMO REVIEW — Ang ganda ng color ng betta at maayos ang sample packaging flow. Perfect pang-test ng review layout."],
    [5, "Carlo D.", "Blue Moscow Guppy Pair", 5, "DEMO REVIEW — Active tingnan yung pair at malinaw ang product details. Ang dali rin i-filter sa Guppies category."],
    [7, "Mika R.", "Red Cherry Shrimp 10 pcs", 5, "DEMO REVIEW — Cute ng shrimp listing! Malinis tingnan sa mobile at obvious agad ang price at stock."],
    [9, "Jessa P.", "Mystery Snail Gold", 4, "DEMO REVIEW — Maganda yung category layout at mabilis makita ang snails. Nice demo product card."],
    [11, "Ruel S.", "Nemo Candy Betta", 5, "DEMO REVIEW — Gusto ko yung Buy Now at Add to Cart buttons. Hindi nakakalito kahit maraming products."],
    [13, "Bea L.", "Blue Dream Shrimp 10 pcs", 5, "DEMO REVIEW — Premium tingnan yung Blue Dream listing. Malinis at bagay sa aquatic store theme."],
    [15, "Kevin T.", "Full Red Guppy Trio", 5, "DEMO REVIEW — Ang dali mag-browse. Helpful yung available stock na nakalagay sa bawat card."],
    [17, "Mae G.", "Nerite Snail 3 pcs", 4, "DEMO REVIEW — Simple pero complete yung product info. Gusto ko rin na may customer reviews section."],
    [19, "Jonas B.", "Avatar Blue Betta", 5, "DEMO REVIEW — Solid yung color theme at responsive sa phone. Mukhang actual online aqua shop na."],
    [21, "Trisha C.", "Yellow Goldenback Shrimp 10 pcs", 5, "DEMO REVIEW — Madaling makita ang Shrimps category at malinaw ang presyo. Good customer-view demo."],
    [23, "Paolo N.", "Samurai Black Betta", 5, "DEMO REVIEW — Clean product grid at hindi crowded. Malakas yung dating ng product name at stock info."],
    [25, "Elle F.", "Pink Ramshorn Snail 5 pcs", 4, "DEMO REVIEW — Cute ng aquatic theme. Okay yung spacing at readable kahit maraming review cards."],
    [27, "Mark A.", "Koi Tuxedo Guppy Trio", 5, "DEMO REVIEW — Ganda ng category chips. Isang click lang, filtered agad ang guppies."],
    [29, "Rica V.", "Amano Shrimp 5 pcs", 5, "DEMO REVIEW — Mas mukhang established shop dahil may products at feedback agad sa customer view."],
    [31, "Dennis Q.", "Dumbo Halfmoon Betta", 5, "DEMO REVIEW — Smooth yung product browsing at maayos yung card design sa desktop."],
    [34, "Faith O.", "Crystal Red Shrimp 5 pcs", 5, "DEMO REVIEW — Nice demo catalog. Malinaw din na hiwalay ang products, categories, at reviews."],
    [38, "Leo H.", "Albino Full Platinum Guppy Pair", 4, "DEMO REVIEW — Maganda pang presentation sa client dahil hindi blank ang storefront."],
    [42, "Kim S.", "Assassin Snail", 5, "DEMO REVIEW — Kumpleto tingnan ang customer page. Helpful din yung Track Order button sa header."]
  ];

  const now = Date.now();
  const demoReviews = reviewDefs.map(([daysAgo, customerName, productName, rating, reviewText], index) => ({
    id: `REV_DEMO_${String(index + 1).padStart(3, "0")}`,
    createdAt: new Date(now - daysAgo * 86400000).toISOString(),
    customerName,
    productId: productByName[productName]?.id || "",
    productName,
    rating,
    reviewText,
    imageUrl: "",
    isDemo: true
  })).reverse();

  return {
    settings: {
      siteName: "Kawaii Aqua Pets",
      tagline: "Quality Betta, Guppies, Snails & Shrimps • Nationwide Shipping",
      gcashName: "Joebert Greganda",
      gcashNumber: "",
      unionBankName: "JOEBERT O GREGANDA",
      unionBankAccountHint: "**** **** 6628",
      paymentNote: "Demo preview only. Connect the Cloudflare Worker API to enable live orders and payments.",
      logoUrl: "",
      lalamoveFormUrl: DEFAULT_LALAMOVE_FORM_URL,
      jntOrderUrl: JNT_ORDER_URL,
      enableLalamove: "true",
      enableLbc: "true",
      enableJnt: "true",
      enableStorePickup: "false",
      facebookPageUrl: "",
      tiktokUrl: "",
      youtubeUrl: ""
    },
    categories: categoryDefs,
    products: demoProducts,
    reviews: demoReviews
  };
}

function formatDate(value) {
  const d = new Date(value);
  return !value || Number.isNaN(d.getTime())
    ? String(value || "")
    : d.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

function setRequired(form, names, required) {
  names.forEach(name => {
    const field = form.elements[name];
    if (field) field.required = required;
  });
}

function settingEnabled(value, fallback = false) {
  if (value == null || String(value).trim() === "") return fallback;
  return value === true || value === 1 || String(value).toLowerCase() === "true" || String(value) === "1";
}

function renderPickupStoreDetails() {
  const box = $("pickupStoreDetails");
  if (!box) return;
  const rows = [
    ["Location", storeSettings.pickupLocationName || "Kawaii Aqua Pets"],
    ["Address", storeSettings.pickupAddress || "Pickup address will be announced by the store."],
    ["Schedule", storeSettings.pickupSchedule || "By confirmed schedule"],
    ["Contact", [storeSettings.pickupContactName, storeSettings.pickupContactNumber].filter(Boolean).join(" • ")],
    ["Instructions", storeSettings.pickupInstructions]
  ].filter(([, value]) => String(value || "").trim());
  box.innerHTML = rows.map(([label, value]) => `<div><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`).join("") +
    (storeSettings.pickupMapsUrl ? `<a class="btn deliveryLink" href="${escapeHtml(storeSettings.pickupMapsUrl)}" target="_blank" rel="noopener">Open Google Maps</a>` : "");
}

function renderDeliveryOptions() {
  const select = $("deliveryMethod");
  if (!select) return;
  const current = select.value;
  const options = [
    ["lalamove", "Lalamove", settingEnabled(storeSettings.enableLalamove, true)],
    ["lbc", "LBC", settingEnabled(storeSettings.enableLbc, true)],
    ["jnt", "J&T Express", settingEnabled(storeSettings.enableJnt, true)],
    ["pickup", "Pick Up at Store", settingEnabled(storeSettings.enableStorePickup, false)]
  ].filter(([, , enabled]) => enabled);

  select.innerHTML = '<option value="">Select delivery method</option>' +
    options.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  if (options.some(([value]) => value === current)) select.value = current;
  $("jntOrderLink").href = storeSettings.jntOrderUrl || JNT_ORDER_URL;
  renderPickupStoreDetails();
}

function syncCheckoutItemsToJnt() {
  const form = $("checkoutForm");
  const items = getCheckoutItems();
  if (!form.jntItemDescription.value.trim()) {
    form.jntItemDescription.value = items.map(item => `${item.name} x${Number(item.qty) || 1}`).join(", ");
  }
  if (!Number(form.jntQuantity.value)) form.jntQuantity.value = items.reduce((sum, item) => sum + (Number(item.qty) || 1), 0) || 1;
  if (!Number(form.jntDeclaredValue.value)) form.jntDeclaredValue.value = checkoutTotal();
}

function syncBaseCustomerToJnt() {
  const form = $("checkoutForm");
  if (!form.jntReceiverName.value.trim()) form.jntReceiverName.value = form.customerName.value.trim();
  if (!form.jntMobile.value.trim()) form.jntMobile.value = form.mobile.value.trim();
  if (!form.jntEmail.value.trim()) form.jntEmail.value = form.email.value.trim();
}

function syncBaseCustomerToLbc() {
  const form = $("checkoutForm");
  if (!form.lbcReceiverName.value.trim()) form.lbcReceiverName.value = form.customerName.value.trim();
  if (!form.lbcMobile.value.trim()) form.lbcMobile.value = form.mobile.value.trim();
  if (!form.lbcEmail.value.trim()) form.lbcEmail.value = form.email.value.trim();
}

function toggleLbcServiceType() {
  const form = $("checkoutForm");
  const isLbc = form.deliveryMethod.value === "lbc";
  const isBranch = isLbc && form.lbcServiceType.value === "Branch Pickup";

  $("lbcDoorFields").classList.toggle("hide", !isLbc || isBranch);
  $("lbcBranchFields").classList.toggle("hide", !isBranch);

  setRequired(form, [
    "lbcProvince",
    "lbcCity",
    "lbcBarangay",
    "lbcPostalCode",
    "lbcHouseUnit",
    "lbcStreet"
  ], isLbc && !isBranch);

  setRequired(form, [
    "lbcBranchProvince",
    "lbcBranchCity",
    "lbcBranchName",
    "lbcValidIdName"
  ], isBranch);
}

function toggleDeliveryFields() {
  const form = $("checkoutForm");
  const method = form.deliveryMethod.value;
  const isLalamove = method === "lalamove";
  const isLbc = method === "lbc";
  const isJnt = method === "jnt";
  const isPickup = method === "pickup";

  $("lalamoveFields").classList.toggle("hide", !isLalamove);
  $("lbcFields").classList.toggle("hide", !isLbc);
  $("jntFields").classList.toggle("hide", !isJnt);
  $("pickupFields").classList.toggle("hide", !isPickup);

  form.address.required = !isPickup;
  form.lalamoveCompleted.required = isLalamove;
  setRequired(form, ["lbcReceiverName", "lbcMobile", "lbcServiceType"], isLbc);
  setRequired(form, [
    "jntReceiverName", "jntMobile", "jntProvince", "jntCity", "jntBarangay", "jntPostalCode",
    "jntHouseUnit", "jntStreet", "jntItemDescription", "jntPickupTime", "jntDeclarationConfirmed"
  ], isJnt);
  setRequired(form, ["pickupPreferredSchedule", "pickupConfirmed"], isPickup);

  if (isLbc) syncBaseCustomerToLbc();
  if (isJnt) {
    syncBaseCustomerToJnt();
    syncCheckoutItemsToJnt();
  }
  const feeNotice = $("shippingFeeNotice");
  if (feeNotice) feeNotice.innerHTML = isPickup
    ? "<b>No courier shipping fee for store pickup.</b> Wait for the pickup-ready confirmation before going to the store."
    : "<b>Shipping fee is not included.</b> The amount shown is for the products only. Shipping will be confirmed separately.";
  toggleLbcServiceType();
}

function buildLbcPayload(form) {
  return {
    receiverName: form.lbcReceiverName.value.trim(), mobile: form.lbcMobile.value.trim(), email: form.lbcEmail.value.trim(),
    serviceType: form.lbcServiceType.value, province: form.lbcProvince.value.trim(), cityMunicipality: form.lbcCity.value.trim(),
    barangay: form.lbcBarangay.value.trim(), postalCode: form.lbcPostalCode.value.trim(), houseUnit: form.lbcHouseUnit.value.trim(),
    streetSubdivision: form.lbcStreet.value.trim(), landmark: form.lbcLandmark.value.trim(),
    branchProvince: form.lbcBranchProvince.value.trim(), branchCity: form.lbcBranchCity.value.trim(),
    branchName: form.lbcBranchName.value.trim(), validIdName: form.lbcValidIdName.value.trim(), instructions: form.lbcInstructions.value.trim()
  };
}

function buildJntPayload(form) {
  return {
    receiverName: form.jntReceiverName.value.trim(), mobile: form.jntMobile.value.trim(), email: form.jntEmail.value.trim(),
    province: form.jntProvince.value.trim(), cityMunicipality: form.jntCity.value.trim(), barangay: form.jntBarangay.value.trim(),
    postalCode: form.jntPostalCode.value.trim(), houseUnit: form.jntHouseUnit.value.trim(), streetSubdivision: form.jntStreet.value.trim(),
    landmark: form.jntLandmark.value.trim(), expressType: form.jntExpressType.value,
    itemDescription: form.jntItemDescription.value.trim(), quantity: Number(form.jntQuantity.value),
    declaredValue: Number(form.jntDeclaredValue.value), weightKg: Number(form.jntWeightKg.value),
    lengthCm: Number(form.jntLengthCm.value), widthCm: Number(form.jntWidthCm.value), heightCm: Number(form.jntHeightCm.value),
    pickupTime: form.jntPickupTime.value, instructions: form.jntInstructions.value.trim(),
    declarationConfirmed: form.jntDeclarationConfirmed.checked
  };
}

function buildPickupPayload(form) {
  return {
    preferredSchedule: form.pickupPreferredSchedule.value.trim(),
    notes: form.pickupNotes.value.trim(),
    confirmed: form.pickupConfirmed.checked
  };
}

safeImage($("logo"));
safeImage($("heroImage"));

$("filter").onchange = () => { renderCategoryChips(); renderProducts(); };
$("trackOrderBtn").onclick = () => openTrackOrder();
$("closeTrackOrder").onclick = () => $("trackOrderDlg").close();
$("trackThisOrderBtn").onclick = () => {
  $("orderSuccessDlg").close();
  openTrackOrder(lastSubmittedOrder ? {
    orderId: lastSubmittedOrder.orderId,
    email: lastSubmittedOrder.email,
    mobile: lastSubmittedOrder.mobile
  } : null);
};
$("cartBtn").onclick = openCart;
$("closeCart").onclick = $("overlay").onclick = closeCart;

$("checkout").onclick = () => openCheckout("cart");

$("closeDlg").onclick = () => {
  $("checkoutDlg").close();
  checkoutMode = "cart";
  buyNowItem = null;
};
$("openReview").onclick = () => $("reviewDlg").showModal();
$("closeReview").onclick = () => $("reviewDlg").close();

$("deliveryMethod").onchange = toggleDeliveryFields;
$("lbcServiceType").onchange = toggleLbcServiceType;
document.querySelectorAll('input[name="paymentMethod"]').forEach(input => {
  input.onchange = renderPaymentDetails;
});
$("downloadQrBtn").onclick = downloadPaymentQr;
$("viewQrBtn").onclick = viewPaymentQr;
$("floatingChatBtn").onclick = openSellerChat;
$("sendOrderSellerBtn").onclick = copyOrderAndOpenSeller;
$("copyOrderBtn").onclick = copyLastOrder;
$("closeOrderSuccess").onclick = () => $("orderSuccessDlg").close();
$("continueShoppingBtn").onclick = () => $("orderSuccessDlg").close();

$("checkoutForm").customerName.addEventListener("change", () => {
  const form = $("checkoutForm");
  if (form.deliveryMethod.value === "lbc" && !form.lbcReceiverName.value.trim()) form.lbcReceiverName.value = form.customerName.value.trim();
  if (form.deliveryMethod.value === "jnt" && !form.jntReceiverName.value.trim()) form.jntReceiverName.value = form.customerName.value.trim();
});

$("checkoutForm").mobile.addEventListener("change", () => {
  const form = $("checkoutForm");
  if (form.deliveryMethod.value === "lbc" && !form.lbcMobile.value.trim()) form.lbcMobile.value = form.mobile.value.trim();
  if (form.deliveryMethod.value === "jnt" && !form.jntMobile.value.trim()) form.jntMobile.value = form.mobile.value.trim();
});

$("checkoutForm").email.addEventListener("change", () => {
  const form = $("checkoutForm");
  if (form.deliveryMethod.value === "lbc" && !form.lbcEmail.value.trim()) form.lbcEmail.value = form.email.value.trim();
  if (form.deliveryMethod.value === "jnt" && !form.jntEmail.value.trim()) form.jntEmail.value = form.email.value.trim();
});

$("trackOrderForm").onsubmit = async event => {
  event.preventDefault();
  const form = event.target;
  const orderId = form.orderId.value.trim();
  const contact = form.contact.value.trim();

  $("trackOrderStatus").textContent = "Checking order...";
  $("trackOrderResult").classList.add("hide");

  try {
    const result = await api("trackOrder", {orderId, contact});
    $("trackOrderStatus").textContent = "";
    renderTrackingResult(result.order);
    localStorage.setItem("kap_last_order_lookup", JSON.stringify({orderId, contact}));
  } catch (err) {
    $("trackOrderStatus").textContent = err.message;
    $("trackOrderResult").innerHTML = "";
  }
};

function createClientRequestId(prefix) {
  if (window.crypto?.randomUUID) return `${prefix}_${window.crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function getOrderRequestId() {
  if (!activeOrderRequestId) activeOrderRequestId = createClientRequestId("order");
  return activeOrderRequestId;
}

function getReviewRequestId() {
  if (!activeReviewRequestId) activeReviewRequestId = createClientRequestId("review");
  return activeReviewRequestId;
}

function setFormSubmitting(form, submitting, busyText) {
  const button = form.querySelector('button[type="submit"]');
  if (!button) return;
  if (!button.dataset.normalText) button.dataset.normalText = button.textContent;
  button.disabled = submitting;
  button.textContent = submitting ? busyText : button.dataset.normalText;
  form.classList.toggle("isSubmitting", submitting);
}

$("checkoutForm").onsubmit = async event => {
  event.preventDefault();
  if (LOCAL_DEMO_MODE) {
    $("status").textContent = "Demo preview only. Connect config.js to your Cloudflare Worker API before submitting live orders.";
    return;
  }
  if (orderSubmitting) return;

  const form = event.target;
  const file = form.proof.files[0];
  const deliveryMethod = form.deliveryMethod.value;
  const paymentMethod = selectedPaymentMethod(form);
  const checkoutItems = getCheckoutItems();

  toggleDeliveryFields();

  if (!form.reportValidity()) return;
  if (!checkoutItems.length) return alert("There are no items to checkout.");
  if (!file) return alert("Please upload your proof of payment.");

  if (deliveryMethod === "lalamove" && !form.lalamoveCompleted.checked) {
    $("status").textContent = "Please complete the Lalamove delivery form and confirm the checkbox.";
    return;
  }

  orderSubmitting = true;
  setFormSubmitting(form, true, "Submitting safely...");
  $("status").textContent = "Optimizing proof and securely submitting your order...";

  try {
    const requestId = getOrderRequestId();
    const data = await api("createOrder", {
      order: {
        clientRequestId: requestId,
        customerName: form.customerName.value.trim(),
        mobile: form.mobile.value.trim(),
        email: form.email.value.trim(),
        address: form.address.value.trim(),
        notes: form.notes.value.trim(),
        items: checkoutItems,
        deliveryMethod,
        paymentMethod,
        lalamoveFormCompleted: form.lalamoveCompleted.checked,
        lbc: deliveryMethod === "lbc" ? buildLbcPayload(form) : {},
        jnt: deliveryMethod === "jnt" ? buildJntPayload(form) : {},
        pickup: deliveryMethod === "pickup" ? buildPickupPayload(form) : {},
        proofData: await optimizeImage(file, 1600, 0.84),
        proofName: file.name
      }
    }, {retries: 3});

    const submittedOrder = {
      orderId: data.orderId,
      total: data.total,
      paymentSummary: data.paymentSummary,
      deliverySummary: data.deliverySummary,
      customerName: form.customerName.value.trim(),
      mobile: form.mobile.value.trim(),
      email: form.email.value.trim(),
      items: checkoutItems.map(item => ({
        name: item.name,
        qty: Number(item.qty),
        price: Number(item.price)
      }))
    };

    $("status").textContent = data.duplicate
      ? `Order already received: ${data.orderId}. No duplicate order was created.`
      : `Order submitted: ${data.orderId}. Waiting for admin payment approval.`;

    if (checkoutMode === "cart") {
      cart = [];
      save();
    }

    checkoutMode = "cart";
    buyNowItem = null;
    activeOrderRequestId = "";
    form.reset();
    renderDeliveryOptions();
    toggleDeliveryFields();
    $("checkoutDlg").close();
    await load(true);
    showOrderSuccess(submittedOrder);
  } catch (err) {
    $("status").textContent = `${err.message} Your checkout details are still here—tap Submit Order again to safely retry.`;
  } finally {
    orderSubmitting = false;
    setFormSubmitting(form, false, "Submitting safely...");
  }
};

$("reviewForm").onsubmit = async event => {
  event.preventDefault();
  if (LOCAL_DEMO_MODE) {
    $("reviewStatus").textContent = "Demo preview only. Connect the Cloudflare Worker API before posting a live review.";
    return;
  }
  if (reviewSubmitting) return;

  const form = event.target;
  const file = form.reviewImage.files[0];
  reviewSubmitting = true;
  setFormSubmitting(form, true, "Submitting safely...");
  $("reviewStatus").textContent = "Submitting review...";

  try {
    const data = await api("createReview", {
      review: {
        clientRequestId: getReviewRequestId(),
        customerName: form.customerName.value.trim(),
        productId: form.productId.value,
        rating: Number(form.rating.value),
        reviewText: form.reviewText.value.trim(),
        imageData: file ? await optimizeImage(file, 1600, 0.84) : "",
        imageName: file ? file.name : ""
      }
    }, {retries: 3});

    $("reviewStatus").textContent = data.duplicate
      ? "This review was already received. No duplicate review was created."
      : "Thank you! Your review has been posted.";
    activeReviewRequestId = "";
    form.reset();
    await load(true);
    setTimeout(() => $("reviewDlg").close(), 1200);
  } catch (err) {
    $("reviewStatus").textContent = `${err.message} You can safely retry without creating a duplicate review.`;
  } finally {
    reviewSubmitting = false;
    setFormSubmitting(form, false, "Submitting safely...");
  }
};

renderDeliveryOptions();
toggleDeliveryFields();
load();
renderCart();

setInterval(() => load(true), 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load(true);
});


$("closeProductDetails")?.addEventListener("click", closeProductDetails);
$("productDetailsDlg")?.addEventListener("click", event => {
  if (event.target === $("productDetailsDlg")) closeProductDetails();
});
$("productDetailsDlg")?.addEventListener("close", () => {
  $("detailVideoFrame").src = "";
});
