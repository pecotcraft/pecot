// 左の目次の長いツール名を、`_` の後ろでだけ折り返せるようにする。
document.addEventListener("DOMContentLoaded", () => {
  for (const link of document.querySelectorAll("#left-sidebar a")) {
    for (const node of [...link.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.includes("_")) continue;
      const parts = node.textContent.split("_");
      const fragment = document.createDocumentFragment();
      parts.forEach((part, index) => {
        fragment.append(index < parts.length - 1 ? `${part}_` : part);
        if (index < parts.length - 1) fragment.append(document.createElement("wbr"));
      });
      node.replaceWith(fragment);
    }
  }
});
