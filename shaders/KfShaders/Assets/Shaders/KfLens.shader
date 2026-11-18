// Lens: chromatic aberration (colour fringes towards the edges), vignette, film grain.
Shader "Hidden/KeyframeStudio/Lens"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
    }
    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "KfCommon.cginc"

            float4 _KfLens;     // x chromatic aberration (0..1), y vignette intensity (0..1), z vignette smoothness (0..1), w vignette roundness (0..1)
            float4 _KfVigColor; // rgb
            float4 _KfGrain;    // x amount (0..1), y size (1..3), z time seed

            float Hash(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }

            fixed4 frag(v2f i) : SV_Target
            {
                float2 uv = i.uv;
                float2 fromCenter = uv - 0.5;
                fixed4 src = tex2D(_MainTex, uv);
                float3 c = src.rgb;

                if (_KfLens.x > 0)
                {
                    float2 off = fromCenter * dot(fromCenter, fromCenter) * _KfLens.x * 0.06;
                    c.r = tex2D(_MainTex, uv - off).r;
                    c.b = tex2D(_MainTex, uv + off).b;
                }

                if (_KfLens.y > 0)
                {
                    float aspect = _ScreenParams.x / _ScreenParams.y;
                    float2 v = fromCenter * float2(lerp(1, aspect, _KfLens.w), 1) * 2;
                    float r = length(v);
                    float soft = max(0.01, _KfLens.z);
                    float mask = smoothstep(1.15 - _KfLens.y * 0.75, 1.15 - _KfLens.y * 0.75 + soft, r);
                    c = lerp(c, _KfVigColor.rgb, mask * saturate(_KfLens.y * 1.5));
                }

                if (_KfGrain.x > 0)
                {
                    float2 g = floor(uv * _ScreenParams.xy / max(1, _KfGrain.y));
                    float n = Hash(g + _KfGrain.z) - 0.5;
                    float l = Luma(c);
                    // strongest in the midtones, like film
                    c += n * _KfGrain.x * 0.25 * (1 - abs(l * 2 - 1) * 0.6);
                }
                return fixed4(saturate(c), src.a);
            }
            ENDCG
        }
    }
    Fallback Off
}
