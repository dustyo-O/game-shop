/**
 * The bundle's entry point, referenced by `index.html`. It does one thing:
 * find the mount point and hand it to the `app` layer.
 */
import { mountApp } from "./app/mount-app.js";

const root = document.querySelector<HTMLDivElement>("#app");

if (root === null) {
  throw new Error("Не найден корневой элемент #app");
}

mountApp(root);
