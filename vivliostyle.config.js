// vivliostyle.config.js
import { defineConfig } from '@vivliostyle/cli';

export default defineConfig({
  title: "My Report",
  author: "Your Name",
  entry: ["bill.html"],
  output: "report.pdf",
});