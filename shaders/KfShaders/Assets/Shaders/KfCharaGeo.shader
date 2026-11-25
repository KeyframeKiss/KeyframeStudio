// Character lights, step 1 (drawn for each shown character part, with its texture): each pixel's surface
// direction (world) and its distance from the camera. Solid parts are not cut by texture alpha (the baked skin and clothes
// textures don't keep coverage there; the light step checks the view's own depth instead); layers over the skin are.
Shader "Hidden/KeyframeStudio/CharaGeo"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
        _KfOverlay ("", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" }
        Cull Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4 _MainTex_ST;
            float _KfOverlay; // a layer over the skin or a cut-out part: cut by its texture, its distance stored negative

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 n : TEXCOORD1;
                float depth : TEXCOORD2;
            };

            v2f vert(appdata_base v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.texcoord, _MainTex);
                o.n = UnityObjectToWorldNormal(v.normal);
                o.depth = -UnityObjectToViewPos(v.vertex).z;
                return o;
            }

            float4 frag(v2f i, fixed facing : VFACE) : SV_Target
            {
                if (_KfOverlay > 0.5) clip(tex2D(_MainTex, i.uv).a - 0.5);
                float3 n = normalize(i.n) * (facing > 0 ? 1 : -1); // back faces (two-sided cloth) face the camera too
                return float4(n, _KfOverlay > 0.5 ? -i.depth : i.depth);
            }
            ENDCG
        }
    }
    Fallback Off
}
