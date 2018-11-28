# CSS Modules for PureScript

[PureScript](https://github.com/purescript/purescript) is great, [CSS Modules](https://github.com/css-modules/css-modules) are great. Why not both?

![Why don’t we have both?](https://i.kym-cdn.com/photos/images/newsfeed/000/538/731/0fc.gif)

This [webpack](https://github/webpack/webpack) plugin lets you import CSS Modules from PureScript :sparkles:

## Installation

```sh
$ npm install --save-dev fretlink/purs-css-modules-webpack-plugin#latest
```

## Configuration

Import the plugin in your webpack configuration file:

```diff
# webpack.config.js
+const PursCSSModulesPlugin = require("purs-css-modules-webpack-plugin");
```

Then add it to your plugins list:

```diff
# webpack.config.js
   plugins: [
+    new PursCSSModulesPlugin()
   ]
```

And configure some loaders for `.purs` and `.css` files:

```diff
# webpack.config.js
   module: {
     rules: [
+      {
+        test: /\.purs$/,
+        exclude: /node_modules/,
+        use: PursCSSModulesPlugin.pursLoader()
+      },
+      {
+        test: /\.css$/,
+        exclude: /node_modules/,
+        use: [
+          "style-loader",
+          PursCSSModulesPlugin.cssLoader()
+        ]
+      }
     ]
   }
```

This plugin uses [purs-loader](https://github.com/fretlink/purs-loader) and [css-loader](https://github.com/webpack-contrib/css-loader) under the hood.

If you need to configure them you can call `PursCSSModulesPlugin.pursLoader` and `PursCSSModulesPlugin.cssLoader` with an object of options accepted by the underlying loaders.

## Usage

Here’s a walkthrough with [React.Basic](https://github.com/lumihq/purescript-react-basic). You can consult the whole example [here](/example).

### Let’s start by creating a React component:

```hs
-- src/Components/App.purs
module Components.App where

import Prelude
import React.Basic (Component, JSX, createComponent, makeStateless)
import React.Basic.DOM as DOM

component :: Component Unit
component = createComponent "App"

app :: JSX
app = unit # makeStateless component \_ ->
  DOM.h1_ [DOM.text "Hello world"]
```

### Now create a stylesheet for this component:

```css
/* src/Components/App.css */
.title {
  font-family: sans-serif;
}
```

### This plugin will create a PureScript module named after the module of your component with a `.CSS` suffix. Import it to make the plugin generate the module on the fly:

```diff
# src/Components/App.purs
 module Components.App where

 import Prelude
 import React.Basic (Component, JSX, createComponent, makeStateless)
 import React.Basic.DOM as DOM
+
+import Components.App.CSS
```

### Let’s look at the generated module:
```hs
-- src/Components/App/CSS.purs
module Components.App.CSS where

import Effect (Effect)

type ClassNames =
  ( "title" :: String )

foreign import importCSSModule :: Effect { | ClassNames }
```

This module exports a few bindings:

  * `ClassNames` is a row describing the stylesheet local class names.
  * `importCSSModule` yields a mapping of the stylesheet local class names to their corresponding compiled class names.

### Let’s use the `title` class declared in `Components/App.css` to style our `h1`. Import the necessary bindings:

```diff
# src/Components/App.purs
-import Components.App.CSS
+import Components.App.CSS (importCSSModule)
```

### Then replace the definition of `app` with this one:

```hs
-- src/Components/App.purs
app :: Effect JSX
app = importCSSModule <#> \{ title } ->
  unit # makeStateless component \_ ->
    DOM.h1 { className: title
           , children: [DOM.text "Hello world"] }
```

You’ll also need to import `Effect`:

```diff
# src/Components/App.purs
 module Components.App where

 import Prelude
+import Effect (Effect)
 import React.Basic (Component, JSX, createComponent, makeStateless)
 import React.Basic.DOM as DOM

 import Components.App.CSS (importCSSModule)
```

Our component isn’t pure anymore: `app` yields some JSX but in doing so it also appends its stylesheet to the DOM. In production you’ll typically extract the CSS of this component, merge it with others, optimize it and load it ahead of time through a `link` with the help of something like [mini-css-extract-plugin](https://github.com/webpack-contrib/mini-css-extract-plugin).
