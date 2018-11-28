const HtmlPlugin = require("html-webpack-plugin");
const PursCssModulesPlugin = require("purs-css-modules-webpack-plugin");

module.exports = {
  entry: __dirname + "/src/index.js",
  plugins: [
    new HtmlPlugin({
      template: "src/index.html"
    }),
    new PursCssModulesPlugin()
  ],
  module: {
    rules: [
      {
        test: /\.purs$/,
        exclude: /node_modules/,
        use: PursCssModulesPlugin.pursLoader({
          pscPackage: true,
          output: __dirname + "/output"
        })
      },
      {
        test: /\.css$/,
        exclude: /node_modules/,
        use: [
          "style-loader",
          PursCssModulesPlugin.cssLoader()
        ]
      },
    ]
  }
};
