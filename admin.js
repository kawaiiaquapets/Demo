const API = window.STORE_API_URL;
const FALLBACK_IMAGE = "assets/logo.png";
const DEFAULT_LALAMOVE_FORM_URL = "https://delivery.lalamove.com/forms/PH4c4ef013d6d54893b979fa6c04c447ca";
const DEFAULT_GCASH_QR = "assets/gcash-qr.jpg";
const DEFAULT_UNIONBANK_QR = "assets/unionbank-qr.jpeg";
const LBC_TRACKING_URL = "https://www.lbcexpress.com/track/";
const JNT_ORDER_URL = "https://www.jtexpress.ph/appOrder";
const JNT_TRACKING_URL = "https://www.jtexpress.ph/trajectoryQuery";
const AUTO_REFRESH_MS = 15000;

let passcode = sessionStorage.getItem("kap_admin_passcode") || "";
let data = {settings:{},categories:[],products:[],orders:[],reviews:[]};
let selectedDeliveryOrder = null;
let adminRefreshing = false;
let autoRefreshTimer = null;
let hasLoadedAdminData = false;
let unseenOrderIds = new Set();
let unseenReviewIds = new Set();
let adminToastTimer = null;

const $ = id => document.getElementById(id);
const peso = n => new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0
}).format(Number(n) || 0);

async function api(action, payload = {}) {
  if (!API || API.includes("PASTE_")) throw new Error("API URL is not configured in config.js");

  const response = await fetch(API, {
    method: "POST",
    headers: {"Content-Type": "text/plain;charset=utf-8"},
    cache: "no-store",
    body: JSON.stringify({
      action,
      passcode,
      ...payload,
      requestTime: Date.now()
    })
  });

  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "Request failed");
  return result;
}

function driveImageUrl(value, size = 1600) {
  const url = String(value || "").trim();
  if (!url) return FALLBACK_IMAGE;
  const match = url.match(/(?:[?&]id=|\/d\/)([-\w]{20,})/);
  return match ? `https://drive.google.com/thumbnail?id=${match[1]}&sz=w${size}` : url;
}

function imageSrc(value, size = 1600) {
  const url = driveImageUrl(value, size);
  return url.startsWith("https://drive.google.com/thumbnail")
    ? `${url}&v=${Date.now()}`
    : url;
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

function formatDate(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime())
    ? String(value || "")
    : date.toLocaleString("en-PH", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
}

function toBool(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value || "");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
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

  const mime = file.type === "image/png" && file.size < 2.5 * 1024 * 1024
    ? "image/png"
    : "image/jpeg";

  return canvas.toDataURL(mime, mime === "image/png" ? undefined : quality);
}

function fileDataUrl(file, maxBytes = 6 * 1024 * 1024) {
  if (!file) return Promise.resolve("");
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("Please select a valid image file."));
  if (file.size > maxBytes) return Promise.reject(new Error("QR image must be 6 MB or less."));

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the QR image."));
    reader.readAsDataURL(file);
  });
}

function waitForAdminRefresh() {
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (!adminRefreshing) {
        clearInterval(timer);
        resolve();
      }
    }, 80);
  });
}

function setRefreshUi(isRefreshing, source = "manual") {
  const button = $("refreshDataBtn");
  if (!button) return;

  button.disabled = isRefreshing;
  button.classList.toggle("refreshing", isRefreshing);
  button.textContent = isRefreshing
    ? source === "auto" ? "Checking..." : "Refreshing..."
    : "↻ Refresh Data";
}

function updateLastRefresh(message = "") {
  const label = $("lastRefreshText");
  if (!label) return;

  if (message) {
    label.textContent = message;
    return;
  }

  label.textContent = `Last update: ${new Date().toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  })}`;
}

function updateNewDataBadges() {
  const orderBadge = $("newOrdersBadge");
  const reviewBadge = $("newReviewsBadge");

  if (orderBadge) {
    orderBadge.textContent = unseenOrderIds.size;
    orderBadge.classList.toggle("hide", unseenOrderIds.size === 0);
  }

  if (reviewBadge) {
    reviewBadge.textContent = unseenReviewIds.size;
    reviewBadge.classList.toggle("hide", unseenReviewIds.size === 0);
  }
}

function showAdminDataToast(title, message, type = "info") {
  const toast = $("adminDataToast");
  if (!toast) return;

  $("adminDataToastTitle").textContent = title;
  $("adminDataToastText").textContent = message;
  toast.classList.toggle("success", type === "success");
  toast.classList.toggle("warning", type === "warning");
  toast.classList.add("show");

  clearTimeout(adminToastTimer);
  adminToastTimer = setTimeout(() => toast.classList.remove("show"), 5000);
}

function renderLiveData() {
  renderOrders();
  renderReviews();
}

async function loadAdmin(options = {}) {
  const {
    renderMode = "all",
    notifyNew = false,
    source = "manual"
  } = options;

  if (adminRefreshing) {
    if (source === "auto") return false;
    await waitForAdminRefresh();
  }

  adminRefreshing = true;
  setRefreshUi(true, source);

  try {
    const previousOrderIds = new Set((data.orders || []).map(order => String(order.id)));
    const previousReviewIds = new Set((data.reviews || []).map(review => String(review.id)));
    const result = await api("adminGetAll");

    const nextData = {
      settings: result.settings || {},
      categories: result.categories || [],
      products: result.products || [],
      orders: result.orders || [],
      reviews: result.reviews || []
    };

    const newOrders = hasLoadedAdminData
      ? nextData.orders.filter(order => !previousOrderIds.has(String(order.id)))
      : [];
    const newReviews = hasLoadedAdminData
      ? nextData.reviews.filter(review => !previousReviewIds.has(String(review.id)))
      : [];

    if (notifyNew) {
      newOrders.forEach(order => unseenOrderIds.add(String(order.id)));
      newReviews.forEach(review => unseenReviewIds.add(String(review.id)));
    }

    data = nextData;

    if (renderMode === "live") renderLiveData();
    else renderAll();

    updateNewDataBadges();
    updateLastRefresh();

    if (notifyNew && (newOrders.length || newReviews.length)) {
      const parts = [];
      if (newOrders.length) parts.push(`${newOrders.length} new order${newOrders.length === 1 ? "" : "s"}`);
      if (newReviews.length) parts.push(`${newReviews.length} new review${newReviews.length === 1 ? "" : "s"}`);
      showAdminDataToast("New data received", parts.join(" • "), "success");
    }

    hasLoadedAdminData = true;
    return true;
  } catch (err) {
    updateLastRefresh(source === "auto" ? "Auto refresh failed • retrying" : "Refresh failed");
    if (source === "auto") return false;
    throw err;
  } finally {
    adminRefreshing = false;
    setRefreshUi(false, source);
  }
}

function startAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (!passcode || document.hidden) return;
    loadAdmin({renderMode: "live", notifyNew: true, source: "auto"});
  }, AUTO_REFRESH_MS);
}

function renderAll() {
  renderSettings();
  renderCategories();
  renderProducts();
  renderOrders();
  renderReviews();
}

function renderSettings() {
  const form = $("settingsForm");
  const settings = data.settings;

  [
    "siteName",
    "tagline",
    "gcashName",
    "gcashNumber",
    "unionBankName",
    "unionBankAccountHint",
    "paymentNote",
    "lalamoveFormUrl",
    "jntOrderUrl",
    "senderName",
    "senderMobile",
    "senderAddress",
    "jntSenderName",
    "jntSenderMobile",
    "jntSenderEmail",
    "jntSenderProvince",
    "jntSenderCity",
    "jntSenderBarangay",
    "jntSenderPostalCode",
    "jntSenderAddress",
    "jntSenderLandmark",
    "pickupLocationName",
    "pickupAddress",
    "pickupMapsUrl",
    "pickupContactName",
    "pickupContactNumber",
    "pickupSchedule",
    "pickupInstructions",
    "facebookPageUrl",
    "tiktokUrl",
    "youtubeUrl"
  ].forEach(key => {
    if (form.elements[key]) form.elements[key].value = settings[key] || "";
  });

  if (!form.elements.lalamoveFormUrl.value) form.elements.lalamoveFormUrl.value = DEFAULT_LALAMOVE_FORM_URL;
  if (!form.elements.jntOrderUrl.value) form.elements.jntOrderUrl.value = JNT_ORDER_URL;
  form.elements.enableLalamove.checked = settingEnabled(settings.enableLalamove, true);
  form.elements.enableLbc.checked = settingEnabled(settings.enableLbc, true);
  form.elements.enableJnt.checked = settingEnabled(settings.enableJnt, true);
  form.elements.enableStorePickup.checked = settingEnabled(settings.enableStorePickup, false);

  $("gcashQrPreview").src = imageSrc(settings.gcashQrUrl || DEFAULT_GCASH_QR, 1400);
  $("unionBankQrPreview").src = imageSrc(settings.unionBankQrUrl || DEFAULT_UNIONBANK_QR, 1400);

  const logo = imageSrc(settings.logoUrl, 1000);
  $("logoPreview").src = logo;
  $("adminTopLogo").src = logo;
  $("adminLoginLogo").src = logo;
  $("adminStoreName").textContent = settings.siteName || "Kawaii Aqua Pets";
}

function settingEnabled(value, fallback = false) {
  if (value == null || String(value).trim() === "") return fallback;
  return toBool(value) || String(value) === "1";
}

function categoryMap() {
  return Object.fromEntries(data.categories.map(category => [category.id, category]));
}

function categoryPath(categoryOrId) {
  const byId = categoryMap();
  let current = typeof categoryOrId === "string" ? byId[categoryOrId] : categoryOrId;
  const parts = [];
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = byId[current.parentId];
  }
  return parts.join(" › ");
}

function categoryDepth(category) {
  const byId = categoryMap();
  let depth = 0;
  let current = category;
  const seen = new Set();
  while (current?.parentId && byId[current.parentId] && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    depth += 1;
    current = byId[current.parentId];
  }
  return depth;
}

function orderedCategories() {
  const children = new Map();
  data.categories.forEach(category => {
    const key = category.parentId || "";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(category);
  });
  children.forEach(list => list.sort((a, b) => String(a.name).localeCompare(String(b.name))));
  const ordered = [];
  const walk = (parentId, depth) => {
    (children.get(parentId) || []).forEach(category => {
      ordered.push({category, depth});
      walk(category.id, depth + 1);
    });
  };
  walk("", 0);
  const known = new Set(ordered.map(item => item.category.id));
  data.categories.filter(category => !known.has(category.id)).forEach(category => ordered.push({category, depth: 0}));
  return ordered;
}

function categoryDescendantIds(id) {
  const result = new Set();
  const visit = parentId => data.categories.filter(category => category.parentId === parentId).forEach(category => {
    if (result.has(category.id)) return;
    result.add(category.id);
    visit(category.id);
  });
  visit(id);
  return result;
}

function renderCategoryParentOptions(editingId = "") {
  const select = $("catForm").elements.parentId;
  const blocked = editingId ? categoryDescendantIds(editingId) : new Set();
  if (editingId) blocked.add(editingId);
  const current = select.value;
  select.innerHTML = '<option value="">Main category</option>' + orderedCategories()
    .filter(({category}) => !blocked.has(category.id))
    .map(({category, depth}) => `<option value="${escapeHtml(category.id)}">${"— ".repeat(depth)}${escapeHtml(category.name)}</option>`)
    .join("");
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function renderCategories() {
  const productCounts = data.products.reduce((counts, product) => {
    counts[product.categoryId] = (counts[product.categoryId] || 0) + 1;
    return counts;
  }, {});

  $("catList").innerHTML = orderedCategories().map(({category, depth}) => `
    <div class="adminListRow categoryAdminRow" style="--category-depth:${depth}">
      <div class="categoryAdminInfo">
        <img src="${escapeHtml(imageSrc(category.imageUrl || FALLBACK_IMAGE, 500))}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" alt="">
        <div>
          <small>${depth ? "Subcategory" : "Main Category"} • ${category.active === false ? "Hidden" : "Visible"}</small>
          <b>${escapeHtml(category.name)}</b>
          <span>${escapeHtml(categoryPath(category))} • ${productCounts[category.id] || 0} direct product${(productCounts[category.id] || 0) === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div class="actions">
        <button onclick="editCategory('${escapeHtml(category.id)}')">Edit</button>
        <button class="danger" onclick="removeCategory('${escapeHtml(category.id)}')">Delete</button>
      </div>
    </div>
  `).join("") || "<p>No categories yet.</p>";

  const editingId = $("catForm").elements.id.value;
  renderCategoryParentOptions(editingId);

  $("prodForm").elements.categoryId.innerHTML =
    '<option value="">Select category or subcategory</option>' +
    orderedCategories().map(({category, depth}) => `<option value="${escapeHtml(category.id)}">${"— ".repeat(depth)}${escapeHtml(category.name)}</option>`).join("");
}

function renderProducts() {
  $("prodList").innerHTML = data.products.map(p => `
    <article class="card prodAdmin">
      <img src="${escapeHtml(imageSrc(p.imageUrl, 900))}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
      <div>
        <small>${escapeHtml(p.categoryPath || p.categoryName || "")}</small>
        <h3>${escapeHtml(p.name)}</h3>
        <p>${escapeHtml(p.description || "")}</p>
        <p><b>${peso(p.price)}</b> • Stock: ${Number(p.stock) || 0} • ${String(p.active) === "false" ? "Hidden" : "Visible"}</p>
        <p class="adminVideoStatus">${toBool(p.videoEnabled) && p.videoUrl ? `▶ Video: ${escapeHtml(String(p.videoType || "Auto-detect").replace(/^./, c => c.toUpperCase()))}` : "No product video"}</p>
        <div class="actions">
          <button onclick="editProduct('${escapeHtml(p.id)}')">Edit</button>
          <button class="danger" onclick="removeProduct('${escapeHtml(p.id)}')">Delete</button>
        </div>
      </div>
    </article>
  `).join("") || "<p>No products yet.</p>";
}

function getDeliveryMethod(order) {
  const method = String(order.deliveryMethod || "").toLowerCase();
  if (method === "lalamove") return "Lalamove";
  if (method === "lbc") return "LBC";
  if (method === "jnt") return "J&T Express";
  if (method === "pickup") return "Store Pickup";
  return "Not set";
}

function getDeliverySummary(order) {
  if (order.deliverySummary) return String(order.deliverySummary);
  const method = getDeliveryMethod(order);
  return method === "Not set" ? "Legacy order" : method;
}

function renderOrders() {
  const statuses = ["Pending", "Paid", "Preparing", "Ready", "Shipped", "Completed", "Cancelled"];

  $("ordersBody").innerHTML = data.orders.map(order => {
    const method = getDeliveryMethod(order);
    const isLbc = method === "LBC";
    const isLalamove = method === "Lalamove";
    const isJnt = method === "J&T Express";
    const isPickup = method === "Store Pickup";
    const lalamoveConfirmed = toBool(order.lalamoveFormCompleted);
    const paymentMethod = String(order.paymentMethod || "").toLowerCase();
    const paymentLabel = paymentMethod === "unionbank" ? "UnionBank" : paymentMethod === "gcash" ? "GCash" : "Not set";
    const paymentClass = paymentMethod === "unionbank" ? "paymentUnionBank" : paymentMethod === "gcash" ? "paymentGcash" : "";

    return `
      <tr>
        <td>${escapeHtml(formatDate(order.createdAt))}</td>
        <td>
          <b>${escapeHtml(order.customerName)}</b><br>
          <small>${escapeHtml(order.mobile)}<br>${escapeHtml(order.email || "No email")}<br>${escapeHtml(order.address)}</small>
        </td>
        <td>
          <span class="courierBadge ${isLbc ? "courierLbc" : isLalamove ? "courierLalamove" : isJnt ? "courierJnt" : isPickup ? "courierPickup" : ""}">${escapeHtml(method)}</span>
          <small class="deliverySummaryText">${escapeHtml(getDeliverySummary(order))}</small>
          ${isLalamove ? `<small class="${lalamoveConfirmed ? "confirmedText" : "warningText"}">${lalamoveConfirmed ? "Customer confirmed form completed" : "No completion confirmation"}</small>` : ""}
        </td>
        <td>${escapeHtml(order.itemsSummary || "")}</td>
        <td>${peso(order.total)}</td>
        <td>
          <span class="paymentBadge ${paymentClass}">${escapeHtml(order.paymentSummary || paymentLabel)}</span>
          ${order.proofUrl ? `<a class="proofLink" href="${escapeHtml(imageSrc(order.proofUrl))}" target="_blank" rel="noopener">View proof</a>` : "—"}
          ${order.receiptEmailStatus ? `<small class="receiptEmailStatus">${escapeHtml(order.receiptEmailStatus)}</small>` : ""}
          ${order.shipmentEmailStatus ? `<small class="shipmentEmailStatus">${escapeHtml(order.shipmentEmailStatus)}</small>` : ""}
        </td>
        <td>
          <select onchange="changeOrderStatus('${escapeHtml(order.id)}',this.value)">
            ${statuses.map(status => `<option value="${status}" ${status === order.status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </td>
        <td>
          <div class="shippingActions">
            <button onclick="viewDelivery('${escapeHtml(order.id)}')">View</button>
            <button onclick="copyDelivery('${escapeHtml(order.id)}')">Copy</button>
            ${(isLbc || isJnt || isPickup) ? `<button class="printShipBtn" onclick="printDelivery('${escapeHtml(order.id)}')">Print</button>` : ""}
            ${isLalamove ? `<a class="smallLinkBtn" href="${escapeHtml(data.settings.lalamoveFormUrl || DEFAULT_LALAMOVE_FORM_URL)}" target="_blank" rel="noopener">Form</a>` : ""}
            ${isJnt ? `<a class="smallLinkBtn" href="${escapeHtml(data.settings.jntOrderUrl || JNT_ORDER_URL)}" target="_blank" rel="noopener">J&T</a>` : ""}
          </div>
          ${order.trackingNumber ? `<small class="trackingAdminSummary"><b>Tracking:</b> ${escapeHtml(order.trackingNumber)}</small>` : ""}
          ${order.trackingUrl ? `<a class="trackingAdminSummary" href="${escapeHtml(order.trackingUrl)}" target="_blank" rel="noopener">Open saved tracking link</a>` : ""}
        </td>
      </tr>
    `;
  }).join("") || '<tr><td colspan="8">No orders yet.</td></tr>';
}

function renderReviews() {
  $("adminReviewsGrid").innerHTML = data.reviews.map(r => `
    <article class="adminReviewCard ${r.imageUrl ? "" : "noPhoto"}">
      ${r.imageUrl ? `<img src="${escapeHtml(imageSrc(r.imageUrl, 700))}" onerror="this.style.display='none'">` : ""}
      <div class="adminReviewContent">
        <div class="reviewStars">${"★".repeat(Number(r.rating) || 5)}</div>
        <h3>${escapeHtml(r.customerName)}</h3>
        ${r.productName ? `<span class="reviewProduct">${escapeHtml(r.productName)}</span>` : ""}
        <p>${escapeHtml(r.reviewText)}</p>
        <div class="adminReviewMeta">${escapeHtml(formatDate(r.createdAt))}</div>
        <button class="deleteReviewBtn" onclick="removeReview('${escapeHtml(r.id)}')">Delete Review</button>
      </div>
    </article>
  `).join("") || "<p>No reviews yet.</p>";
}

function deliveryRowsHtml(rows) {
  return `
    <dl class="deliveryDetailsList">
      ${rows.filter(([, value]) => String(value || "").trim()).map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `).join("")}
    </dl>
  `;
}

function getOrderDeliveryData(order) {
  return parseJson(order.deliveryJson, {});
}

function buildDeliveryHtml(order) {
  const method = getDeliveryMethod(order);
  const delivery = getOrderDeliveryData(order);

  let html = `
    <div class="deliveryOrderMeta">
      <b>Order ${escapeHtml(order.id)}</b>
      <span>${escapeHtml(formatDate(order.createdAt))}</span>
      <span>Status: ${escapeHtml(order.status || "")}</span>
    </div>
  `;

  if (method === "LBC") {
    const serviceType = delivery.serviceType || "Door-to-Door";

    html += `
      <div class="detailSection">
        <h3>Receiver Information</h3>
        ${deliveryRowsHtml([
          ["Receiver full name", delivery.receiverName],
          ["Mobile number", delivery.mobile],
          ["Customer receipt email", order.email],
          ["LBC email address", delivery.email],
          ["Receiving option", serviceType]
        ])}
      </div>
    `;

    if (serviceType === "Branch Pickup") {
      html += `
        <div class="detailSection">
          <h3>Requested Branch Pickup Details</h3>
          ${deliveryRowsHtml([
            ["Province", delivery.branchProvince],
            ["City / Municipality", delivery.branchCity],
            ["Preferred LBC branch", delivery.branchName],
            ["Name on valid ID", delivery.validIdName],
            ["Instructions", delivery.instructions]
          ])}
        </div>
      `;
    } else {
      html += `
        <div class="detailSection">
          <h3>Door-to-Door Address</h3>
          ${deliveryRowsHtml([
            ["House / Unit / Lot / Block", delivery.houseUnit],
            ["Street / Subdivision", delivery.streetSubdivision],
            ["Barangay", delivery.barangay],
            ["City / Municipality", delivery.cityMunicipality],
            ["Province", delivery.province],
            ["Postal / ZIP code", delivery.postalCode],
            ["Landmark", delivery.landmark],
            ["Instructions", delivery.instructions]
          ])}
        </div>
      `;
    }
  } else if (method === "Lalamove") {
    const formUrl = data.settings.lalamoveFormUrl || DEFAULT_LALAMOVE_FORM_URL;
    html += `
      <div class="detailSection">
        <h3>Lalamove</h3>
        ${deliveryRowsHtml([
          ["Customer confirmation", toBool(order.lalamoveFormCompleted) ? "Completed Lalamove form" : "Not confirmed"],
          ["Customer name", order.customerName], ["Mobile number", order.mobile],
          ["Email address", order.email], ["Base address", order.address]
        ])}
        <a class="btn deliveryLink" href="${escapeHtml(formUrl)}" target="_blank" rel="noopener">Open Lalamove Form</a>
      </div>
    `;
  } else if (method === "J&T Express") {
    html += `
      <div class="detailSection"><h3>J&T Recipient Information</h3>${deliveryRowsHtml([
        ["Receiver full name", delivery.receiverName], ["Mobile number", delivery.mobile], ["Email", delivery.email],
        ["House / Unit / Lot / Block", delivery.houseUnit], ["Street / Subdivision", delivery.streetSubdivision],
        ["Barangay", delivery.barangay], ["City / Municipality", delivery.cityMunicipality],
        ["Province", delivery.province], ["Postal / ZIP code", delivery.postalCode], ["Landmark", delivery.landmark]
      ])}</div>
      <div class="detailSection"><h3>J&T Package and Pickup</h3>${deliveryRowsHtml([
        ["Express type", delivery.expressType], ["Accurate item description", delivery.itemDescription],
        ["Quantity", delivery.quantity], ["Declared value", peso(delivery.declaredValue)],
        ["Weight", delivery.weightKg ? `${delivery.weightKg} kg` : ""],
        ["Dimensions", (delivery.lengthCm || delivery.widthCm || delivery.heightCm) ? `${delivery.lengthCm || 0} × ${delivery.widthCm || 0} × ${delivery.heightCm || 0} cm` : ""],
        ["Pickup time", delivery.pickupTime], ["Special instructions", delivery.instructions],
        ["Content declaration", delivery.declarationConfirmed ? "Customer confirmed accurate declaration" : "Not confirmed"]
      ])}<a class="btn deliveryLink" href="${escapeHtml(delivery.orderUrl || data.settings.jntOrderUrl || JNT_ORDER_URL)}" target="_blank" rel="noopener">Open Official J&T Booking</a></div>
      <div class="detailSection"><h3>Saved J&T Sender Information</h3>${deliveryRowsHtml([
        ["Sender name", delivery.senderName], ["Mobile", delivery.senderMobile], ["Email", delivery.senderEmail],
        ["Pickup address", delivery.senderAddress], ["Barangay", delivery.senderBarangay], ["City / Municipality", delivery.senderCity],
        ["Province", delivery.senderProvince], ["Postal / ZIP code", delivery.senderPostalCode], ["Landmark", delivery.senderLandmark]
      ])}</div>
    `;
  } else if (method === "Store Pickup") {
    html += `
      <div class="detailSection"><h3>Store Pickup</h3>${deliveryRowsHtml([
        ["Pickup location", delivery.locationName], ["Address", delivery.address], ["Store schedule", delivery.storeSchedule],
        ["Contact person", delivery.contactName], ["Contact number", delivery.contactNumber],
        ["Customer preferred schedule", delivery.preferredSchedule], ["Customer notes", delivery.customerNotes],
        ["Pickup instructions", delivery.instructions]
      ])}${delivery.mapsUrl ? `<a class="btn deliveryLink" href="${escapeHtml(delivery.mapsUrl)}" target="_blank" rel="noopener">Open Google Maps</a>` : ""}</div>
    `;
  } else {
    html += `
      <div class="detailSection">
        <h3>Legacy Order</h3>
        ${deliveryRowsHtml([
          ["Customer name", order.customerName],
          ["Mobile number", order.mobile],
          ["Email address", order.email],
          ["Address", order.address],
          ["Notes", order.notes]
        ])}
      </div>
    `;
  }

  if (order.trackingNumber || order.trackingUrl) {
    html += `
      <div class="detailSection">
        <h3>Saved Tracking Details</h3>
        ${deliveryRowsHtml([
          ["Tracking number", order.trackingNumber],
          ["Tracking / share link", order.trackingUrl]
        ])}
      </div>
    `;
  }

  html += `
    <div class="detailSection">
      <h3>Order</h3>
      ${deliveryRowsHtml([
        ["Items", order.itemsSummary],
        ["Total", peso(order.total)],
        ["Customer notes", order.notes]
      ])}
    </div>
  `;

  return html;
}

function buildShippingText(order) {
  const method = getDeliveryMethod(order);
  const delivery = getOrderDeliveryData(order);
  const lines = [
    "KAWAII AQUA PETS - SHIPPING DETAILS",
    `ORDER ID: ${order.id || ""}`,
    `DELIVERY METHOD: ${method}`,
    `ORDER STATUS: ${order.status || ""}`,
    `TRACKING NUMBER: ${order.trackingNumber || ""}`,
    `TRACKING / SHARE LINK: ${order.trackingUrl || ""}`,
    ""
  ];

  if (method === "LBC") {
    lines.push(
      "RECEIVER INFORMATION",
      `Full Name: ${delivery.receiverName || ""}`,
      `Mobile: ${delivery.mobile || ""}`,
      `Email: ${delivery.email || ""}`,
      `Receiving Option: ${delivery.serviceType || "Door-to-Door"}`,
      ""
    );

    if (delivery.serviceType === "Branch Pickup") {
      lines.push(
        "REQUESTED BRANCH PICKUP DETAILS",
        `Province: ${delivery.branchProvince || ""}`,
        `City / Municipality: ${delivery.branchCity || ""}`,
        `Preferred LBC Branch: ${delivery.branchName || ""}`,
        `Name on Valid ID: ${delivery.validIdName || ""}`,
        `Instructions: ${delivery.instructions || ""}`,
        ""
      );
    } else {
      lines.push(
        "DOOR-TO-DOOR ADDRESS",
        `House / Unit / Lot / Block: ${delivery.houseUnit || ""}`,
        `Street / Subdivision: ${delivery.streetSubdivision || ""}`,
        `Barangay: ${delivery.barangay || ""}`,
        `City / Municipality: ${delivery.cityMunicipality || ""}`,
        `Province: ${delivery.province || ""}`,
        `Postal / ZIP Code: ${delivery.postalCode || ""}`,
        `Landmark: ${delivery.landmark || ""}`,
        `Instructions: ${delivery.instructions || ""}`,
        ""
      );
    }
  } else if (method === "Lalamove") {
    lines.push(
      "LALAMOVE",
      `Customer Confirmed Form Completed: ${toBool(order.lalamoveFormCompleted) ? "YES" : "NO"}`,
      `Customer: ${order.customerName || ""}`, `Mobile: ${order.mobile || ""}`,
      `Email: ${order.email || ""}`, `Base Address: ${order.address || ""}`,
      `Form URL: ${data.settings.lalamoveFormUrl || DEFAULT_LALAMOVE_FORM_URL}`, ""
    );
  } else if (method === "J&T Express") {
    lines.push(
      "J&T RECIPIENT INFORMATION",
      `Full Name: ${delivery.receiverName || ""}`, `Mobile: ${delivery.mobile || ""}`, `Email: ${delivery.email || ""}`,
      `House / Unit / Lot / Block: ${delivery.houseUnit || ""}`, `Street / Subdivision: ${delivery.streetSubdivision || ""}`,
      `Barangay: ${delivery.barangay || ""}`, `City / Municipality: ${delivery.cityMunicipality || ""}`,
      `Province: ${delivery.province || ""}`, `Postal / ZIP Code: ${delivery.postalCode || ""}`, `Landmark: ${delivery.landmark || ""}`, "",
      "J&T PACKAGE INFORMATION",
      `Express Type: ${delivery.expressType || "EZ"}`, `Accurate Item Description: ${delivery.itemDescription || ""}`,
      `Quantity: ${delivery.quantity || 1}`, `Declared Value: ${peso(delivery.declaredValue)}`,
      `Weight: ${delivery.weightKg || 0} kg`, `Dimensions: ${delivery.lengthCm || 0} x ${delivery.widthCm || 0} x ${delivery.heightCm || 0} cm`,
      `Pickup Time: ${delivery.pickupTime || ""}`, `Instructions: ${delivery.instructions || ""}`,
      `Accurate Content Declaration Confirmed: ${delivery.declarationConfirmed ? "YES" : "NO"}`, "",
      "J&T SENDER / PICKUP INFORMATION",
      `Sender: ${delivery.senderName || ""}`, `Mobile: ${delivery.senderMobile || ""}`, `Email: ${delivery.senderEmail || ""}`,
      `Pickup Address: ${delivery.senderAddress || ""}`, `Barangay: ${delivery.senderBarangay || ""}`,
      `City / Municipality: ${delivery.senderCity || ""}`, `Province: ${delivery.senderProvince || ""}`,
      `Postal / ZIP Code: ${delivery.senderPostalCode || ""}`, `Landmark: ${delivery.senderLandmark || ""}`,
      `Official Booking Page: ${delivery.orderUrl || data.settings.jntOrderUrl || JNT_ORDER_URL}`, ""
    );
  } else if (method === "Store Pickup") {
    lines.push(
      "STORE PICKUP DETAILS",
      `Location: ${delivery.locationName || ""}`, `Address: ${delivery.address || ""}`,
      `Store Schedule: ${delivery.storeSchedule || ""}`, `Contact: ${delivery.contactName || ""}`,
      `Contact Number: ${delivery.contactNumber || ""}`, `Customer Preferred Schedule: ${delivery.preferredSchedule || ""}`,
      `Customer Notes: ${delivery.customerNotes || ""}`, `Pickup Instructions: ${delivery.instructions || ""}`,
      `Google Maps: ${delivery.mapsUrl || ""}`, ""
    );
  } else {
    lines.push(
      "CUSTOMER DETAILS",
      `Customer: ${order.customerName || ""}`,
      `Mobile: ${order.mobile || ""}`,
      `Email: ${order.email || ""}`,
      `Address: ${order.address || ""}`,
      ""
    );
  }

  lines.push(
    "ORDER DETAILS",
    `Items: ${order.itemsSummary || ""}`,
    `Total: ${peso(order.total)}`,
    `Payment: ${order.paymentSummary || order.paymentMethod || "Not set"}`,
    `Notes: ${order.notes || ""}`,
    ""
  );

  if (method === "LBC") {
    lines.push(
      "SENDER DETAILS",
      `Store: ${data.settings.siteName || "Kawaii Aqua Pets"}`,
      `Sender: ${data.settings.senderName || ""}`,
      `Mobile: ${data.settings.senderMobile || ""}`,
      `Return Address: ${data.settings.senderAddress || ""}`
    );
  }

  return lines.join("\n");
}

function clearCategoryForm() {
  const form = $("catForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.active.checked = true;
  $("categoryPreview").src = FALLBACK_IMAGE;
  $("catMsg").textContent = "";
  renderCategoryParentOptions("");
}

window.editCategory = id => {
  const category = data.categories.find(x => x.id === id);
  if (!category) return;
  const form = $("catForm");
  form.elements.id.value = category.id;
  renderCategoryParentOptions(category.id);
  form.elements.name.value = category.name;
  form.elements.parentId.value = category.parentId || "";
  form.elements.active.checked = category.active !== false;
  $("categoryPreview").src = imageSrc(category.imageUrl || FALLBACK_IMAGE, 900);
  form.elements.name.focus();
};

window.removeCategory = async id => {
  if (!confirm("Delete this category?")) return;
  try {
    await api("deleteCategory", {id});
    await loadAdmin();
  } catch (err) {
    alert(err.message);
  }
};

window.editProduct = id => {
  const product = data.products.find(x => x.id === id);
  if (!product) return;

  const form = $("prodForm");
  form.elements.id.value = product.id;
  form.elements.name.value = product.name;
  form.elements.categoryId.value = product.categoryId;
  form.elements.price.value = product.price;
  form.elements.stock.value = product.stock;
  form.elements.description.value = product.description || "";
  form.elements.videoType.value = product.videoType || "";
  form.elements.videoUrl.value = product.videoUrl || "";
  form.elements.videoEnabled.checked = toBool(product.videoEnabled);
  form.elements.active.checked = String(product.active) !== "false";
  $("productPreview").src = imageSrc(product.imageUrl, 1000);

  document.querySelector('[data-tab="products"]').click();
  window.scrollTo({top: 0, behavior: "smooth"});
};

window.removeProduct = async id => {
  if (!confirm("Delete this product and its stored image?")) return;
  try {
    await api("deleteProduct", {id});
    await loadAdmin();
  } catch (err) {
    alert(err.message);
  }
};

window.changeOrderStatus = async (id, status) => {
  const order = data.orders.find(x => x.id === id);
  if (!order) return;

  if (status === "Shipped") {
    const method = getDeliveryMethod(order);
    const missingTracking = (method === "LBC" || method === "J&T Express")
      ? !String(order.trackingNumber || "").trim()
      : method === "Lalamove"
        ? !String(order.trackingUrl || "").trim()
        : false;

    if (missingTracking) {
      const detail = method === "LBC" ? "LBC tracking number" : method === "J&T Express" ? "J&T tracking number" : "Lalamove tracking/share link";
      if (!confirm(`No ${detail} is saved yet. Mark this order Shipped anyway?`)) {
        await loadAdmin();
        return;
      }
    }
  }

  try {
    const result = await api("updateOrderStatus", {id, status});

    if (result.inventoryAction === "deducted") {
      const emailMessage = result.emailNotification?.message || "Receipt email status is unavailable.";
      alert("Payment approved. Stock was deducted.\n\n" + emailMessage);
    }

    if (result.inventoryAction === "restored") {
      alert("Order cancelled. Stock was restored.");
    }

    if (result.shippingEmailNotification) {
      alert("Order marked as Shipped.\n\n" + result.shippingEmailNotification.message);
    }

    await loadAdmin();
  } catch (err) {
    alert(err.message);
    await loadAdmin();
  }
};

window.removeReview = async id => {
  if (!confirm("Delete this review and its photo?")) return;
  try {
    await api("deleteReview", {id});
    await loadAdmin();
  } catch (err) {
    alert(err.message);
  }
};

window.viewDelivery = id => {
  const order = data.orders.find(x => x.id === id);
  if (!order) return;

  selectedDeliveryOrder = order;
  $("deliveryDlgTitle").textContent = `${getDeliveryMethod(order)} Shipping Details`;
  $("deliveryDetailContent").innerHTML = buildDeliveryHtml(order);
  $("printDeliveryBtn").classList.toggle("hide", !["LBC", "J&T Express", "Store Pickup"].includes(getDeliveryMethod(order)));
  populateTrackingEditor(order);
  $("deliveryActionMsg").textContent = "";
  $("deliveryDlg").showModal();
};

function populateTrackingEditor(order) {
  const method = getDeliveryMethod(order);
  const isLbc = method === "LBC";
  const isLalamove = method === "Lalamove";
  const isJnt = method === "J&T Express";

  $("trackingAdminPanel").classList.toggle("hide", !isLbc && !isLalamove && !isJnt);
  $("trackingNumberLabel").classList.toggle("hide", !isLbc && !isJnt);
  $("trackingNumberInput").value = order.trackingNumber || "";
  $("trackingUrlInput").value = order.trackingUrl || "";
  $("trackingSaveMsg").textContent = "";

  if (isLbc) {
    $("trackingUrlLabel").childNodes[0].nodeValue = "Tracking page URL ";
    $("trackingUrlInput").placeholder = LBC_TRACKING_URL;
    $("trackingAdminHelp").textContent = "Enter the LBC tracking number. The customer Track Order page will use the official LBC tracking page when the optional URL is blank.";
  } else if (isJnt) {
    $("trackingUrlLabel").childNodes[0].nodeValue = "J&T tracking page URL ";
    $("trackingUrlInput").placeholder = JNT_TRACKING_URL;
    $("trackingAdminHelp").textContent = "Enter the J&T waybill or tracking number. The customer Track Order page will open the official J&T tracking page when the optional URL is blank.";
  } else if (isLalamove) {
    $("trackingUrlLabel").childNodes[0].nodeValue = "Lalamove tracking / share link ";
    $("trackingUrlInput").placeholder = "https://...";
    $("trackingAdminHelp").textContent = "Paste the live tracking or share link from your Lalamove delivery. This link will be shown to the customer.";
  }
}

window.copyDelivery = async id => {
  const order = data.orders.find(x => x.id === id);
  if (!order) return;

  try {
    await navigator.clipboard.writeText(buildShippingText(order));
    alert("Shipping details copied.");
  } catch {
    viewDelivery(id);
    $("deliveryActionMsg").textContent = "Browser blocked automatic copy. Select and copy the details from the dialog.";
  }
};

window.printDelivery = id => {
  const order = data.orders.find(x => x.id === id);
  if (!order) return;
  const method = getDeliveryMethod(order);
  if (!["LBC", "J&T Express", "Store Pickup"].includes(method)) return alert("A printable shipping detail sheet is not available for this delivery method.");

  const text = buildShippingText(order);
  const printWindow = window.open("", "_blank", "width=650,height=850");

  if (!printWindow) {
    alert("Pop-up was blocked. Allow pop-ups and try again.");
    return;
  }

  printWindow.document.write(`
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(order.id || "Shipping Details")}</title>
      <style>
        @page{size:4in 6in;margin:.2in}
        *{box-sizing:border-box}
        body{font-family:Arial,sans-serif;margin:0;color:#111;font-size:11px}
        .label{border:2px solid #111;padding:14px;min-height:5.5in}
        h1{font-size:18px;margin:0 0 10px;text-align:center}
        pre{font:inherit;white-space:pre-wrap;line-height:1.42;margin:0}
        .note{margin-top:12px;padding-top:8px;border-top:1px dashed #555;font-size:9px}
      </style>
    </head>
    <body>
      <div class="label">
        <h1>${escapeHtml(method.toUpperCase())} DETAILS</h1>
        <pre>${escapeHtml(text)}</pre>
        <div class="note">Prepared by Kawaii Aqua Pets. This is a store-prepared detail sheet, not an official courier waybill, barcode, or booking confirmation.</div>
      </div>
      <script>window.onload=()=>window.print();<\/script>
    </body>
    </html>
  `);

  printWindow.document.close();
};

function clearProductForm() {
  const form = $("prodForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.stock.value = 1;
  form.elements.videoType.value = "";
  form.elements.videoUrl.value = "";
  form.elements.videoEnabled.checked = false;
  form.elements.active.checked = true;
  $("productPreview").src = FALLBACK_IMAGE;
  $("prodMsg").textContent = "";
}

$("loginForm").onsubmit = async event => {
  event.preventDefault();
  passcode = $("pass").value;
  $("loginMsg").textContent = "Checking...";

  try {
    await loadAdmin({renderMode: "all", source: "login"});
    sessionStorage.setItem("kap_admin_passcode", passcode);
    $("login").classList.add("hide");
    $("dash").classList.remove("hide");
    $("loginMsg").textContent = "";
    startAutoRefresh();
  } catch (err) {
    $("loginMsg").textContent = err.message;
    passcode = "";
  }
};

$("settingsForm").onsubmit = async event => {
  event.preventDefault();
  const form = event.target;
  const file = form.logoFile.files[0];
  const gcashQrFile = form.gcashQrFile.files[0];
  const unionBankQrFile = form.unionBankQrFile.files[0];
  $("settingsMsg").textContent = "Optimizing images and saving...";

  try {
    await api("saveSettings", {
      settings: {
        siteName: form.siteName.value.trim(),
        tagline: form.tagline.value.trim(),
        gcashName: form.gcashName.value.trim(),
        gcashNumber: form.gcashNumber.value.trim(),
        unionBankName: form.unionBankName.value.trim(),
        unionBankAccountHint: form.unionBankAccountHint.value.trim(),
        paymentNote: form.paymentNote.value.trim(),
        enableLalamove: form.enableLalamove.checked,
        enableLbc: form.enableLbc.checked,
        enableJnt: form.enableJnt.checked,
        enableStorePickup: form.enableStorePickup.checked,
        lalamoveFormUrl: form.lalamoveFormUrl.value.trim() || DEFAULT_LALAMOVE_FORM_URL,
        jntOrderUrl: form.jntOrderUrl.value.trim() || JNT_ORDER_URL,
        senderName: form.senderName.value.trim(),
        senderMobile: form.senderMobile.value.trim(),
        senderAddress: form.senderAddress.value.trim(),
        jntSenderName: form.jntSenderName.value.trim(),
        jntSenderMobile: form.jntSenderMobile.value.trim(),
        jntSenderEmail: form.jntSenderEmail.value.trim(),
        jntSenderProvince: form.jntSenderProvince.value.trim(),
        jntSenderCity: form.jntSenderCity.value.trim(),
        jntSenderBarangay: form.jntSenderBarangay.value.trim(),
        jntSenderPostalCode: form.jntSenderPostalCode.value.trim(),
        jntSenderAddress: form.jntSenderAddress.value.trim(),
        jntSenderLandmark: form.jntSenderLandmark.value.trim(),
        pickupLocationName: form.pickupLocationName.value.trim(),
        pickupAddress: form.pickupAddress.value.trim(),
        pickupMapsUrl: form.pickupMapsUrl.value.trim(),
        pickupContactName: form.pickupContactName.value.trim(),
        pickupContactNumber: form.pickupContactNumber.value.trim(),
        pickupSchedule: form.pickupSchedule.value.trim(),
        pickupInstructions: form.pickupInstructions.value.trim(),
        facebookPageUrl: form.facebookPageUrl.value.trim(),
        tiktokUrl: form.tiktokUrl.value.trim(),
        youtubeUrl: form.youtubeUrl.value.trim(),
        logoData: file ? await optimizeImage(file, 1400, 0.9) : "",
        logoName: file ? file.name : "",
        gcashQrData: gcashQrFile ? await fileDataUrl(gcashQrFile) : "",
        gcashQrName: gcashQrFile ? gcashQrFile.name : "",
        unionBankQrData: unionBankQrFile ? await fileDataUrl(unionBankQrFile) : "",
        unionBankQrName: unionBankQrFile ? unionBankQrFile.name : ""
      }
    });

    form.logoFile.value = "";
    form.gcashQrFile.value = "";
    form.unionBankQrFile.value = "";
    await loadAdmin();
    $("settingsMsg").textContent = "Settings saved.";
  } catch (err) {
    $("settingsMsg").textContent = err.message;
  }
};

$("catForm").onsubmit = async event => {
  event.preventDefault();
  const form = event.target;
  const file = form.imageFile.files[0];
  $("catMsg").textContent = "Optimizing image and saving...";

  try {
    await api("saveCategory", {
      category: {
        id: form.id.value,
        name: form.name.value.trim(),
        parentId: form.parentId.value,
        active: form.active.checked,
        imageData: file ? await optimizeImage(file, 1400, 0.86) : "",
        imageName: file ? file.name : ""
      }
    });
    clearCategoryForm();
    await loadAdmin();
    $("catMsg").textContent = "Category saved successfully.";
  } catch (err) {
    $("catMsg").textContent = err.message;
  }
};

$("prodForm").onsubmit = async event => {
  event.preventDefault();
  const form = event.target;
  const file = form.imageFile.files[0];

  if (!form.id.value && !file) {
    $("prodMsg").textContent = "Please select a product image for a new product.";
    return;
  }

  $("prodMsg").textContent = "Optimizing image and saving...";

  try {
    await api("saveProduct", {
      product: {
        id: form.id.value,
        name: form.name.value.trim(),
        categoryId: form.categoryId.value,
        price: Number(form.price.value),
        stock: Number(form.stock.value),
        description: form.description.value.trim(),
        videoType: form.videoType.value,
        videoUrl: form.videoUrl.value.trim(),
        videoEnabled: form.videoEnabled.checked,
        active: form.active.checked,
        imageData: file ? await optimizeImage(file, 1600, 0.86) : "",
        imageName: file ? file.name : ""
      }
    });

    clearProductForm();
    await loadAdmin();
    $("prodMsg").textContent = "Product saved successfully.";
  } catch (err) {
    $("prodMsg").textContent = err.message;
  }
};

$("cancelProductEdit").onclick = clearProductForm;

$("settingsForm").logoFile.onchange = event => {
  const file = event.target.files[0];
  if (file) $("logoPreview").src = URL.createObjectURL(file);
};

$("settingsForm").gcashQrFile.onchange = event => {
  const file = event.target.files[0];
  if (file) $("gcashQrPreview").src = URL.createObjectURL(file);
};

$("settingsForm").unionBankQrFile.onchange = event => {
  const file = event.target.files[0];
  if (file) $("unionBankQrPreview").src = URL.createObjectURL(file);
};

$("catForm").imageFile.onchange = event => {
  const file = event.target.files[0];
  if (file) $("categoryPreview").src = URL.createObjectURL(file);
};
$("cancelCategoryEdit").onclick = clearCategoryForm;

$("prodForm").imageFile.onchange = event => {
  const file = event.target.files[0];
  if (file) $("productPreview").src = URL.createObjectURL(file);
};

$("closeDeliveryDlg").onclick = () => $("deliveryDlg").close();

$("copyDeliveryBtn").onclick = async () => {
  if (!selectedDeliveryOrder) return;

  try {
    await navigator.clipboard.writeText(buildShippingText(selectedDeliveryOrder));
    $("deliveryActionMsg").textContent = "Shipping details copied.";
  } catch {
    $("deliveryActionMsg").textContent = "Browser blocked automatic copy.";
  }
};

$("printDeliveryBtn").onclick = () => {
  if (selectedDeliveryOrder) printDelivery(selectedDeliveryOrder.id);
};

$("saveTrackingBtn").onclick = async () => {
  if (!selectedDeliveryOrder) return;

  $("trackingSaveMsg").textContent = "Saving tracking details...";

  try {
    await api("saveTrackingInfo", {
      id: selectedDeliveryOrder.id,
      trackingNumber: $("trackingNumberInput").value.trim(),
      trackingUrl: $("trackingUrlInput").value.trim()
    });

    await loadAdmin();
    selectedDeliveryOrder = data.orders.find(order => order.id === selectedDeliveryOrder.id) || null;

    if (selectedDeliveryOrder) {
      $("deliveryDetailContent").innerHTML = buildDeliveryHtml(selectedDeliveryOrder);
      populateTrackingEditor(selectedDeliveryOrder);
      $("trackingSaveMsg").textContent = "Tracking details saved.";
    }
  } catch (err) {
    $("trackingSaveMsg").textContent = err.message;
  }
};

$("refreshDataBtn").onclick = async () => {
  try {
    const previousOrders = new Set(data.orders.map(order => String(order.id)));
    const previousReviews = new Set(data.reviews.map(review => String(review.id)));
    await loadAdmin({renderMode: "live", notifyNew: true, source: "manual"});

    const hasNewOrder = data.orders.some(order => !previousOrders.has(String(order.id)));
    const hasNewReview = data.reviews.some(review => !previousReviews.has(String(review.id)));
    if (!hasNewOrder && !hasNewReview) {
      showAdminDataToast("Data refreshed", "Orders and reviews are already up to date.");
    }
  } catch (err) {
    showAdminDataToast("Refresh failed", err.message, "warning");
  }
};

$("closeAdminDataToast").onclick = () => $("adminDataToast").classList.remove("show");

document.querySelectorAll("[data-tab]").forEach(button => {
  button.onclick = () => {
    document.querySelectorAll(".tabPanel").forEach(panel => panel.classList.add("hide"));
    $(button.dataset.tab).classList.remove("hide");

    if (button.dataset.tab === "orders") unseenOrderIds.clear();
    if (button.dataset.tab === "reviews") unseenReviewIds.clear();
    updateNewDataBadges();
  };
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && passcode) {
    loadAdmin({renderMode: "live", notifyNew: true, source: "auto"});
  }
});

if (passcode) {
  loadAdmin({renderMode: "all", source: "session"})
    .then(() => {
      $("login").classList.add("hide");
      $("dash").classList.remove("hide");
      startAutoRefresh();
    })
    .catch(() => {
      sessionStorage.removeItem("kap_admin_passcode");
      passcode = "";
    });
}
